import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import {
  defaultProjectConfig,
  loadProjectConfig,
  PROJECT_CONFIG_PATH,
  serializeProjectConfig,
  validateProjectConfig,
} from '../core/config.js';
import { harnessStateRoot, projectIdFor } from '../core/state-paths.js';
import type { ProjectConfig, QwenBillingPlan } from '../core/types.js';
import { ProjectRegistry } from '../registry.js';
import { runProcess } from '../runtime/safe-process.js';
import {
  DEFAULT_QWEN_BASE_URL,
  MIN_QWEN_CODE_VERSION,
  QWEN_MM_CORE_MCP_SERVER,
  TOKEN_PLAN_QWEN_BASE_URL,
  detectedQwenCodeVersion,
  qwenCodeVersionAtLeast,
  qwenMmCoreCheckArgs,
  qwenMmCoreInstallArgs,
} from '../qwen/runtime-compat.js';
import { resolveQwenCredential } from '../qwen/credential-resolver.js';
import { installWorkerService, uninstallWorkerService, type ServiceReceipt } from './service.js';

export interface InstallAnswers {
  projectName: string;
  githubRepo: string;
  trustedAuthor: string;
  qwenBaseUrl: string;
  qwenCredentialEnvKey: string;
  qwenBillingPlan: QwenBillingPlan;
  autoMerge: boolean;
  enableCommunity: boolean;
  enableProgram: boolean;
  installQwen: boolean;
  linkExtension: boolean;
  installMultimodal: boolean;
  installBrowserAutomation: boolean;
  bootstrapDependencies: boolean;
  installCli: boolean;
  installService: boolean;
  persistCredentials: boolean;
  configureGitHub: boolean;
}

export interface InstallOptions {
  root: string;
  dryRun?: boolean;
  yes?: boolean;
  answers?: Partial<InstallAnswers>;
}

export interface InstalledFileReceipt {
  path: string;
  sha256: string;
  owned: boolean;
  backup?: string;
  outcome?: 'written' | 'unchanged' | 'preserved';
}

export interface InstallReceipt {
  version: 1;
  harnessVersion: string;
  projectId: string;
  root: string;
  installedAt: number;
  files: InstalledFileReceipt[];
  service?: ServiceReceipt;
  extensionLinked?: boolean;
}

export async function installProject(options: InstallOptions): Promise<{ config: ProjectConfig; receipt: InstallReceipt; summary: string[] }> {
  const requestedRoot = path.resolve(options.root);
  if (!existsSync(requestedRoot) || !statSync(requestedRoot).isDirectory()) throw new Error(`Project directory does not exist: ${requestedRoot}`);
  const root = realpathSync(requestedRoot);
  const receiptPath = path.join(root, '.qwen-harness', 'install-receipt.json');
  assertSafeTarget(root, receiptPath);
  const previousReceipt = readInstallReceipt(receiptPath);
  if (previousReceipt) validateReceiptPaths(previousReceipt, root);
  const previousFiles = new Map(previousReceipt?.files.map((file) => [file.path, file]) ?? []);
  const packageRoot = findPackageRoot();
  const configTarget = path.join(root, PROJECT_CONFIG_PATH);
  assertSafeTarget(root, configTarget);
  const existingConfig = existsSync(configTarget) ? loadProjectConfig(configTarget) : null;
  const detectedRepo =
    options.answers?.githubRepo ?? existingConfig?.project.githubRepo ?? (await detectRepository(root));
  const detectedAuthor =
    options.answers?.trustedAuthor ??
    existingConfig?.intake.trustedAuthors.find((author) => author !== 'github-actions[bot]') ??
    (await detectGitHubUser(root));
  const requestedQwenCommand = existingConfig?.qwen.command ?? 'qwen';
  let qwenRuntime = requestedQwenCommand === 'qwen'
    ? await resolveQwenRuntime(requestedQwenCommand, root)
    : { command: requestedQwenCommand, version: await detectQwenVersion(requestedQwenCommand, root) };
  const defaults: InstallAnswers = {
    projectName: existingConfig?.project.name ?? path.basename(root),
    githubRepo: detectedRepo,
    trustedAuthor: detectedAuthor,
    qwenBaseUrl:
      existingConfig?.qwen.baseUrl ??
      process.env.DASHSCOPE_BASE_URL ??
      defaultProjectConfig(root).qwen.baseUrl,
    qwenCredentialEnvKey: existingConfig?.qwen.credentialEnvKey ?? 'DASHSCOPE_API_KEY',
    qwenBillingPlan: existingConfig?.qwen.billingPlan ?? 'standard',
    autoMerge: existingConfig?.worker.autoMerge ?? true,
    enableCommunity: existingConfig?.intake.communityEnabled ?? false,
    enableProgram: existingConfig?.program.enabled ?? true,
    installQwen: !options.yes && !qwenCodeVersionAtLeast(qwenRuntime.version),
    linkExtension: previousReceipt?.extensionLinked ?? true,
    installMultimodal: false,
    installBrowserAutomation: false,
    bootstrapDependencies: true,
    installCli: options.yes ? false : true,
    installService: previousReceipt ? Boolean(previousReceipt.service?.installed) : true,
    persistCredentials: false,
    configureGitHub: false,
  };
  const supplied = Object.fromEntries(
    Object.entries(options.answers ?? {}).filter(([, value]) => value !== undefined),
  ) as Partial<InstallAnswers>;
  const answers = options.yes
    ? { ...defaults, ...supplied }
    : await guidedAnswers({ ...defaults, ...supplied });
  if (answers.qwenBillingPlan.startsWith('token-plan-')) {
    if (!supplied.qwenBaseUrl && options.yes) answers.qwenBaseUrl = TOKEN_PLAN_QWEN_BASE_URL;
    if (!supplied.qwenCredentialEnvKey && options.yes) answers.qwenCredentialEnvKey = 'BAILIAN_TOKEN_PLAN_API_KEY';
  }
  if (answers.installQwen && !options.dryRun) {
    const installed = await runProcess({
      command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
      args: ['install', '-g', '@qwen-code/qwen-code@latest'],
      cwd: packageRoot,
      timeoutMs: 10 * 60_000,
    });
    if (installed.exitCode !== 0) throw new Error(`Qwen Code installation failed: ${installed.stderr}`);
    qwenRuntime = await resolveQwenRuntime('qwen', root);
    if (!qwenCodeVersionAtLeast(qwenRuntime.version)) {
      throw new Error(
        `Qwen Code ${MIN_QWEN_CODE_VERSION}+ was installed, but PATH still selects ${detectedQwenCodeVersion(qwenRuntime.version) ?? 'an incompatible version'}. Remove or unlink the older Qwen installation, then rerun setup.`,
      );
    }
  }
  const runtimePackageRoot = !options.dryRun && (answers.linkExtension || answers.installCli || answers.installService)
    ? await installImmutableHarnessRuntime(packageRoot)
    : packageRoot;
  const config = existingConfig ?? defaultProjectConfig(root, answers.projectName, answers.githubRepo);
  config.project.root = root;
  config.project.name = answers.projectName;
  config.project.githubRepo = answers.githubRepo;
  config.qwen.baseUrl = answers.qwenBaseUrl;
  config.qwen.credentialEnvKey = answers.qwenCredentialEnvKey;
  config.qwen.billingPlan = answers.qwenBillingPlan;
  config.qwen.command = qwenRuntime.command;
  config.worker.autoMerge = answers.autoMerge;
  config.intake.communityEnabled = answers.enableCommunity;
  config.program.enabled = answers.enableProgram;
  if (answers.enableProgram && config.configVersion === 1) config.configVersion = 2;
  for (const protectedPath of defaultProjectConfig(root).protectedPaths) {
    if (!config.protectedPaths.includes(protectedPath)) config.protectedPaths.push(protectedPath);
  }
  if (answers.installMultimodal && !config.qwen.allowedMcpServers.includes(QWEN_MM_CORE_MCP_SERVER)) {
    config.qwen.allowedMcpServers.push(QWEN_MM_CORE_MCP_SERVER);
  }
  if (answers.trustedAuthor && !config.intake.trustedAuthors.includes(answers.trustedAuthor)) {
    config.intake.trustedAuthors.push(answers.trustedAuthor);
  }
  validateProjectConfig(config, 'generated project configuration');

  const summary: string[] = [];
  const receipts: InstalledFileReceipt[] = [];
  const templateRoot = path.join(packageRoot, 'template');
  const templateSources = listFiles(templateRoot);
  const qwenSettings = path.join(root, '.qwen', 'settings.json');
  assertSafeTarget(root, qwenSettings);
  assertSafeTarget(root, path.join(root, '.gitignore'));
  for (const source of templateSources) {
    assertSafeTarget(root, path.join(root, path.relative(templateRoot, source)));
  }
  for (const source of templateSources) {
    const relative = path.relative(templateRoot, source);
    const target = path.join(root, relative);
    const rendered = renderTemplate(readFileSync(source, 'utf8'), config, answers);
    const receipt = writeManagedFile(
      target,
      Buffer.from(rendered),
      root,
      Boolean(options.dryRun),
      false,
      true,
      previousFiles.get(relative),
    );
    receipts.push(receipt);
    summary.push(
      receipt.outcome === 'preserved'
        ? `preserved existing ${relative}; verify the required harness behavior manually`
        : receipt.outcome === 'unchanged'
          ? `unchanged ${relative}`
          : `${options.dryRun ? 'would install' : 'installed'} ${relative}`,
    );
  }

  const configReceipt = writeManagedFile(
    configTarget,
    Buffer.from(serializeProjectConfig(config)),
    root,
    Boolean(options.dryRun),
    true,
    true,
    previousFiles.get(PROJECT_CONFIG_PATH),
    false,
  );
  receipts.push(configReceipt);
  summary.push(
    configReceipt.outcome === 'unchanged'
      ? `unchanged ${PROJECT_CONFIG_PATH}`
      : `${options.dryRun ? 'would write' : 'wrote'} ${PROJECT_CONFIG_PATH}`,
  );

  const mergedSettings = mergeQwenSettings(qwenSettings, config);
  const settingsRelative = path.join('.qwen', 'settings.json');
  const settingsReceipt = writeManagedFile(
    qwenSettings,
    Buffer.from(`${JSON.stringify(mergedSettings, null, 2)}\n`),
    root,
    Boolean(options.dryRun),
    true,
    true,
    previousFiles.get(settingsRelative),
    false,
    true,
  );
  receipts.push(settingsReceipt);
  summary.push(
    settingsReceipt.outcome === 'unchanged'
      ? `unchanged ${settingsRelative}`
      : `${options.dryRun ? 'would configure' : 'configured'} ${settingsRelative}`,
  );
  ensureGitignore(root, Boolean(options.dryRun));

  const receipt: InstallReceipt = {
    version: 1,
    harnessVersion: readHarnessVersion(packageRoot),
    projectId: projectIdFor(config),
    root,
    installedAt: Date.now(),
    files: receipts,
    service: previousReceipt?.service,
    extensionLinked: previousReceipt?.extensionLinked ?? false,
  };
  const persistReceipt = (): void => {
    if (options.dryRun) return;
    mkdirSync(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
    atomicWrite(receiptPath, Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`), 0o600);
  };
  persistReceipt();

  let service: ServiceReceipt | undefined = previousReceipt?.service;
  if (answers.installQwen) {
    summary.push(`${options.dryRun ? 'would install/upgrade' : 'installed/upgraded'} Qwen Code with npm`);
  } else if (!qwenCodeVersionAtLeast(qwenRuntime.version)) {
    summary.push(
      `Qwen Code ${MIN_QWEN_CODE_VERSION}+ is still required; rerun with --install-qwen or upgrade it manually`,
    );
  }
  if (answers.linkExtension) {
    summary.push(`${options.dryRun ? 'would link' : 'linked'} Qwen extension from ${runtimePackageRoot}`);
    if (!options.dryRun) {
      await ensureQwenExtensionLink(config.qwen.command, root, runtimePackageRoot);
      receipt.extensionLinked = true;
      persistReceipt();
    }
  }
  if (answers.installMultimodal) {
    summary.push(`${options.dryRun ? 'would install and verify' : 'installed and verified'} Qwen-MM-Plugins core capability`);
    if (!options.dryRun) {
      const uvx = await runProcess({
        command: 'uvx',
        args: ['--version'],
        cwd: root,
        timeoutMs: 20_000,
      });
      if (uvx.exitCode !== 0) {
        throw new Error('Qwen-MM-Plugins requires uv/uvx. Install it from https://docs.astral.sh/uv/ and rerun setup with --with-mm.');
      }
      const installed = await runProcess({
        command: config.qwen.command,
        args: qwenMmCoreInstallArgs(),
        cwd: root,
        timeoutMs: 10 * 60_000,
      });
      if (installed.exitCode !== 0) throw new Error(`Qwen-MM-Plugins installation failed: ${installed.stderr}`);
      const verified = await runProcess({
        command: 'uvx',
        args: qwenMmCoreCheckArgs(),
        cwd: root,
        timeoutMs: 10 * 60_000,
        maxOutputBytes: 5 * 1024 * 1024,
      });
      if (verified.exitCode !== 0) {
        throw new Error(`Qwen-MM-Plugins core installed but its system check failed: ${(verified.stderr || verified.stdout).slice(-2_000)}`);
      }
    }
  }
  if (answers.installBrowserAutomation) {
    summary.push(`${options.dryRun ? 'would add' : 'added'} project-local Playwright browser automation`);
    if (!options.dryRun) await installPlaywright(root);
  }
  if (answers.bootstrapDependencies) {
    summary.push(`${options.dryRun ? 'would install and verify' : 'installed and verified'} target project dependencies and declared browser runtimes`);
    if (!options.dryRun) {
      const bootstrapped = await runProcess({
        command: process.execPath,
        args: [path.join(root, '.qwen-harness', 'scripts', 'bootstrap.mjs')],
        cwd: root,
        timeoutMs: 20 * 60_000,
        maxOutputBytes: 10 * 1024 * 1024,
      });
      if (bootstrapped.exitCode !== 0) {
        throw new Error(`Target dependency setup failed: ${(bootstrapped.stderr || bootstrapped.stdout).slice(-2_000)}`);
      }
    }
  }
  if (answers.installCli) {
    summary.push(`${options.dryRun ? 'would expose' : 'exposed'} the qwen-harness CLI through npm link`);
    if (!options.dryRun) {
      const linked = await runProcess({
        command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
        args: ['link', '--ignore-scripts'],
        cwd: runtimePackageRoot,
        timeoutMs: 2 * 60_000,
      });
      if (linked.exitCode !== 0) throw new Error(`Could not expose qwen-harness CLI: ${linked.stderr}`);
      const verified = await runProcess({
        command: process.platform === 'win32' ? 'qwen-harness.cmd' : 'qwen-harness',
        args: ['--version'],
        cwd: root,
        timeoutMs: 20_000,
      });
      if (verified.exitCode !== 0 || !verified.stdout.includes(readHarnessVersion(packageRoot))) {
        throw new Error('npm link completed but qwen-harness is not available on PATH');
      }
    }
  }

  if (!options.dryRun) {
    new ProjectRegistry().register({
      id: projectIdFor(config),
      root,
      configPath: configTarget,
      enabled: true,
    });
  }
  summary.push(`${options.dryRun ? 'would register' : 'registered'} project with qwen-harnessd`);

  if (answers.installService) {
    const credential = resolveQwenCredential(config);
    if (answers.persistCredentials && !credential) {
      throw new Error(`--persist-api-key requires ${config.qwen.credentialEnvKey} in Qwen user settings or the setup process environment`);
    }
    service = await installWorkerService(path.join(runtimePackageRoot, 'bin', 'qwen-harness.mjs'), {
      dryRun: Boolean(options.dryRun),
      persistCredentials: answers.persistCredentials,
      credentialEnvKey: config.qwen.credentialEnvKey,
      credentialValue: credential?.apiKey,
    });
    if (!options.dryRun && !service.installed) throw new Error(`Worker service installation failed: ${service.message}`);
    receipt.service = service;
    persistReceipt();
    summary.push(service.message);
    summary.push(
      service.credentialsPersisted
        ? `stored ${config.qwen.credentialEnvKey} in the mode-0600 worker environment file`
        : 'worker credential was not copied; the harness will reuse Qwen user settings when available',
    );
  }
  if (answers.configureGitHub && answers.githubRepo) {
    await configureGitHubRepository(config, Boolean(options.dryRun));
    summary.push(`${options.dryRun ? 'would configure' : 'configured'} GitHub labels and branch protection`);
  }

  receipt.service = service;
  persistReceipt();
  return { config, receipt, summary };
}

export async function uninstallProject(rootInput: string, options: { removeService?: boolean } = {}): Promise<string[]> {
  const requestedRoot = path.resolve(rootInput);
  if (!existsSync(requestedRoot) || !statSync(requestedRoot).isDirectory()) throw new Error(`Project directory does not exist: ${requestedRoot}`);
  const root = realpathSync(requestedRoot);
  const receiptPath = path.join(root, '.qwen-harness', 'install-receipt.json');
  assertSafeTarget(root, receiptPath);
  if (!existsSync(receiptPath)) throw new Error(`No install receipt found at ${receiptPath}`);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as InstallReceipt;
  validateReceiptPaths(receipt, root);
  const actions: string[] = [];
  for (const file of receipt.files) {
    const target = safeProjectPath(root, file.path);
    if (!existsSync(target)) continue;
    const unchanged = sha256(readFileSync(target)) === file.sha256;
    if (file.owned && !unchanged) {
      actions.push(`kept modified ${file.path}`);
      continue;
    }
    if (file.owned) {
      rmSync(target);
      actions.push(`removed ${file.path}`);
      continue;
    }
    if (file.path === path.join('.qwen', 'settings.json') && unchanged) {
      removeHarnessQwenSettings(target, file.backup ? safeProjectPath(root, file.backup) : undefined);
      actions.push(`removed harness entries from ${file.path}`);
      continue;
    }
    if (file.backup && unchanged) {
      const backup = safeProjectPath(root, file.backup);
      if (existsSync(backup)) {
        cpSync(backup, target);
        actions.push(`restored ${file.path}`);
      }
    }
  }
  if (removeGitignoreBlock(root)) actions.push('removed qwen-harness block from .gitignore');
  new ProjectRegistry().unregister(receipt.projectId);
  actions.push('unregistered project');
  if (options.removeService) {
    await uninstallWorkerService();
    actions.push('removed worker service');
  }
  rmSync(receiptPath);
  return actions;
}

async function guidedAnswers(defaults: InstallAnswers): Promise<InstallAnswers> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ask = async (message: string, fallback: string): Promise<string> => {
      const answer = (await terminal.question(`${message}${fallback ? ` [${fallback}]` : ''}: `)).trim();
      return answer || fallback;
    };
    const yesNo = async (message: string, fallback: boolean): Promise<boolean> => {
      const hint = fallback ? 'Y/n' : 'y/N';
      const answer = (await terminal.question(`${message} [${hint}]: `)).trim().toLowerCase();
      if (!answer) return fallback;
      return answer === 'y' || answer === 'yes';
    };
    const projectName = await ask('Project name', defaults.projectName);
    const githubRepo = await ask('GitHub repository (owner/name)', defaults.githubRepo);
    const trustedAuthor = await ask('Trusted GitHub automation/operator login', defaults.trustedAuthor);
    const qwenBillingPlan = await chooseQwenBillingPlan(terminal, defaults.qwenBillingPlan);
    const suggestedBaseUrl = qwenBillingPlan.startsWith('token-plan-')
      ? TOKEN_PLAN_QWEN_BASE_URL
      : qwenBillingPlan === 'standard'
        ? DEFAULT_QWEN_BASE_URL
        : defaults.qwenBaseUrl;
    const suggestedCredential = qwenBillingPlan.startsWith('token-plan-')
      ? 'BAILIAN_TOKEN_PLAN_API_KEY'
      : defaults.qwenCredentialEnvKey;
    const qwenBaseUrl = await ask('Qwen API base URL', suggestedBaseUrl);
    const qwenCredentialEnvKey = await ask('Qwen credential name (press Enter to accept)', suggestedCredential);
    const autoMerge = await yesNo('Enable automatic merge after every gate passes?', defaults.autoMerge);
    const enableCommunity = await yesNo('Scan allowlisted community sources for reviewable improvement ideas?', defaults.enableCommunity);
    const enableProgram = await yesNo('Enable repository-aware objective programs and dependency waves?', defaults.enableProgram);
    const installQwen = await yesNo(
      `Install/upgrade Qwen Code globally with npm (requires ${MIN_QWEN_CODE_VERSION}+)?`,
      defaults.installQwen,
    );
    const linkExtension = await yesNo('Link the delivery harness extension for this user?', defaults.linkExtension);
    const installMultimodal = await yesNo('Install Qwen-MM-Plugins core for multimodal tools?', false);
    const installBrowserAutomation = await yesNo('Add project-local Playwright for browser/E2E work?', false);
    const bootstrapDependencies = await yesNo('Install/check the target project dependencies and declared browser runtimes now?', true);
    const installCli = await yesNo('Expose the qwen-harness command through npm link?', true);
    const installService = await yesNo('Install/start the persistent local worker service?', true);
    const credential = resolveQwenCredential({ qwen: { ...defaultProjectConfig(process.cwd()).qwen, credentialEnvKey: qwenCredentialEnvKey } });
    const persistCredentials = installService && credential
      ? await yesNo(`Copy ${qwenCredentialEnvKey} into the background worker's mode-0600 environment file?`, false)
      : false;
    const configureGitHub = githubRepo
      ? await yesNo('Create harness labels and configure branch protection now?', true)
      : false;
    return {
      projectName,
      githubRepo,
      trustedAuthor,
      qwenBaseUrl,
      qwenCredentialEnvKey,
      qwenBillingPlan,
      autoMerge,
      enableCommunity,
      enableProgram,
      installQwen,
      linkExtension,
      installMultimodal,
      installBrowserAutomation,
      bootstrapDependencies,
      installCli,
      installService,
      persistCredentials,
      configureGitHub,
    };
  } finally {
    terminal.close();
  }
}

async function chooseQwenBillingPlan(
  terminal: ReturnType<typeof createInterface>,
  fallback: InstallAnswers['qwenBillingPlan'],
): Promise<InstallAnswers['qwenBillingPlan']> {
  const plans: Array<{ value: InstallAnswers['qwenBillingPlan']; label: string }> = [
    { value: 'standard', label: 'Standard QwenCloud API key / pay-as-you-go' },
    { value: 'token-plan-personal', label: 'Token Plan Personal' },
    { value: 'token-plan-team', label: 'Token Plan Team' },
    { value: 'custom', label: 'Custom OpenAI-compatible Qwen endpoint' },
  ];
  console.log('\nQwen billing plan:');
  plans.forEach((plan, index) => console.log(`  ${index + 1}. ${plan.label}${plan.value === fallback ? ' [default]' : ''}`));
  const answer = (await terminal.question('Choose 1-4: ')).trim();
  if (!answer) return fallback;
  const selected = plans[Number(answer) - 1];
  if (!selected) throw new Error('Choose a Qwen billing plan from 1 through 4');
  return selected.value;
}

async function installPlaywright(root: string): Promise<void> {
  const packageFile = path.join(root, 'package.json');
  if (!existsSync(packageFile)) throw new Error('Playwright setup requires a Node project with package.json');
  const manifest = JSON.parse(readFileSync(packageFile, 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  if (manifest.dependencies?.['@playwright/test'] || manifest.devDependencies?.['@playwright/test']) return;
  const command = existsSync(path.join(root, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : existsSync(path.join(root, 'yarn.lock'))
      ? 'yarn'
      : existsSync(path.join(root, 'bun.lock')) || existsSync(path.join(root, 'bun.lockb'))
        ? 'bun'
        : process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = command === 'pnpm'
    ? ['add', '--save-dev', '@playwright/test@latest']
    : command === 'yarn'
      ? ['add', '--dev', '@playwright/test@latest']
      : command === 'bun'
        ? ['add', '--dev', '@playwright/test@latest']
        : ['install', '--save-dev', '@playwright/test@latest'];
  const installed = await runProcess({ command, args, cwd: root, timeoutMs: 10 * 60_000, maxOutputBytes: 10 * 1024 * 1024 });
  if (installed.exitCode !== 0) throw new Error(`Playwright package installation failed: ${(installed.stderr || installed.stdout).slice(-2_000)}`);
}

function writeManagedFile(
  target: string,
  content: Buffer,
  root: string,
  dryRun: boolean,
  replaceOwned = false,
  ownedWhenCreated = true,
  previous?: InstalledFileReceipt,
  preserveModified = true,
  retainOriginalBackup = false,
): InstalledFileReceipt {
  assertSafeTarget(root, target);
  const relative = path.relative(root, target);
  const existed = existsSync(target);
  const current = existed ? readFileSync(target) : null;
  const currentSha = current ? sha256(current) : null;
  const modifiedOwnedFile = Boolean(existed && previous?.owned && currentSha !== previous.sha256);
  if (current?.equals(content)) {
    return {
      path: relative,
      sha256: sha256(content),
      owned: modifiedOwnedFile ? false : previous?.owned ?? false,
      backup: previous?.backup,
      outcome: 'unchanged',
    };
  }
  if (existed && previous?.owned && currentSha !== previous.sha256 && preserveModified) {
    return { ...previous, outcome: 'preserved' };
  }
  let backup = previous?.backup;
  if (existed) {
    const safeManagedUpdate = Boolean(previous?.owned && currentSha === previous.sha256);
    if (!safeManagedUpdate && !replaceOwned) {
      return previous?.owned
        ? { ...previous, outcome: 'preserved' }
        : { path: relative, sha256: currentSha as string, owned: false, backup, outcome: 'preserved' };
    }
    const changedSinceReceipt = Boolean(previous && currentSha !== previous.sha256);
    if (!backup || (changedSinceReceipt && !retainOriginalBackup)) {
      backup = path.join('.qwen-harness', 'backups', `${Date.now()}-${process.pid}`, relative);
    }
    if (!dryRun && !existsSync(path.join(root, backup))) {
      const backupPath = path.join(root, backup);
      mkdirSync(path.dirname(backupPath), { recursive: true, mode: 0o700 });
      cpSync(target, backupPath);
    }
  }
  if (!dryRun) {
    mkdirSync(path.dirname(target), { recursive: true });
    atomicWrite(target, content, target.includes('.qwen-harness') ? 0o600 : 0o644);
  }
  return {
    path: relative,
    sha256: sha256(content),
    owned: modifiedOwnedFile ? false : previous?.owned ?? (!existed && ownedWhenCreated),
    backup,
    outcome: 'written',
  };
}

function readInstallReceipt(file: string): InstallReceipt | null {
  if (!existsSync(file)) return null;
  try {
    const receipt = JSON.parse(readFileSync(file, 'utf8')) as InstallReceipt;
    return receipt.version === 1 && Array.isArray(receipt.files) ? receipt : null;
  } catch {
    throw new Error(`${file} is not a valid install receipt; repair or move it before updating`);
  }
}

function validateReceiptPaths(receipt: InstallReceipt, root: string): void {
  if (receipt.version !== 1 || !Array.isArray(receipt.files)) throw new Error('Unsupported install receipt');
  for (const file of receipt.files) {
    if (!file || typeof file.path !== 'string' || typeof file.sha256 !== 'string' || typeof file.owned !== 'boolean') {
      throw new Error('Install receipt contains an invalid file entry');
    }
    safeProjectPath(root, file.path);
    if (file.backup) safeProjectPath(root, file.backup);
  }
}

function mergeQwenSettings(file: string, config: ProjectConfig): Record<string, unknown> {
  let existing: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      existing = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      throw new Error(`${file} is not valid JSON; fix it before running setup`);
    }
  }
  const existingProviders = isRecord(existing.modelProviders) ? existing.modelProviders : {};
  const existingOpenAi = Array.isArray(existingProviders.openai)
    ? existingProviders.openai.filter(isRecord)
    : [];
  const currentQwenProvider =
    existingOpenAi.find((provider) => provider.id === config.qwen.model) ?? {};
  const qwenProvider = deepMerge(currentQwenProvider, {
    id: config.qwen.model,
    name: `${config.qwen.model} (QwenCloud)`,
    description: 'Qwen3.8-Max for the autonomous engineering harness',
    baseUrl: config.qwen.baseUrl,
    envKey: config.qwen.credentialEnvKey,
    generationConfig: {
      extra_body: { enable_thinking: true, preserve_thinking: true },
    },
  });
  const merged = deepMerge(existing, {
    model: {
      name: config.qwen.model,
      reasoningEffort: config.qwen.implementationReasoning,
      maxSessionTurns: config.qwen.maxSessionTurns,
      maxToolCalls: config.qwen.maxToolCalls,
      maxSubagentDepth: config.qwen.maxSubagentDepth,
    },
    tools: {
      approvalMode: config.qwen.approvalMode,
      sandbox: config.qwen.sandbox,
      workflowsEnabled: true,
      computerUse: { enabled: false },
    },
    mcp: { allowed: [...config.qwen.allowedMcpServers] },
    general: { chatRecording: true },
    security: { auth: { selectedType: 'openai' } },
  });
  merged.modelProviders = {
    ...existingProviders,
    openai: [
      ...existingOpenAi.filter((provider) => provider.id !== config.qwen.model),
      qwenProvider,
    ],
  };
  return merged;
}

function ensureGitignore(root: string, dryRun: boolean): void {
  const file = path.join(root, '.gitignore');
  assertSafeTarget(root, file);
  const block = gitignoreBlock();
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (current.includes('# qwen-harness managed state') || dryRun) return;
  atomicWrite(file, Buffer.from(`${current}${current && !current.endsWith('\n') ? '\n' : ''}${block}`), 0o644);
}

function removeGitignoreBlock(root: string): boolean {
  const file = path.join(root, '.gitignore');
  assertSafeTarget(root, file);
  if (!existsSync(file)) return false;
  const current = readFileSync(file, 'utf8');
  const next = current.replace(gitignoreBlock(), '');
  if (next === current) return false;
  atomicWrite(file, Buffer.from(next), 0o644);
  return true;
}

function removeHarnessQwenSettings(file: string, originalFile?: string): void {
  const current = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const original =
    originalFile && existsSync(originalFile)
      ? (JSON.parse(readFileSync(originalFile, 'utf8')) as Record<string, unknown>)
      : {};
  const cleaned = structuredClone(current);
  for (const managedPath of [
    ['model', 'name'],
    ['model', 'reasoningEffort'],
    ['model', 'maxSessionTurns'],
    ['model', 'maxToolCalls'],
    ['model', 'maxSubagentDepth'],
    ['tools', 'approvalMode'],
    ['tools', 'sandbox'],
    ['tools', 'workflowsEnabled'],
    ['tools', 'computerUse', 'enabled'],
    ['mcp', 'allowed'],
    ['general', 'chatRecording'],
    ['security', 'auth', 'selectedType'],
  ]) {
    restorePath(cleaned, original, managedPath);
  }
  const providers = isRecord(cleaned.modelProviders) ? cleaned.modelProviders : {};
  const currentOpenAi = Array.isArray(providers.openai) ? providers.openai.filter(isRecord) : [];
  const originalProviders = isRecord(original.modelProviders) ? original.modelProviders : {};
  const originalOpenAi = Array.isArray(originalProviders.openai) ? originalProviders.openai.filter(isRecord) : [];
  const restoredOpenAi = [
    ...currentOpenAi.filter((provider) => provider.id !== 'qwen3.8-max'),
    ...originalOpenAi.filter((provider) => provider.id === 'qwen3.8-max'),
  ];
  if (restoredOpenAi.length > 0) providers.openai = restoredOpenAi;
  else delete providers.openai;
  cleaned.modelProviders = providers;
  pruneEmptyObjects(cleaned);
  if (Object.keys(cleaned).length === 0) rmSync(file);
  else atomicWrite(file, Buffer.from(`${JSON.stringify(cleaned, null, 2)}\n`), 0o644);
}

function restorePath(target: Record<string, unknown>, original: Record<string, unknown>, parts: string[]): void {
  let targetCursor: Record<string, unknown> | undefined = target;
  let originalCursor: Record<string, unknown> | undefined = original;
  for (const part of parts.slice(0, -1)) {
    targetCursor = targetCursor && isRecord(targetCursor[part]) ? targetCursor[part] as Record<string, unknown> : undefined;
    originalCursor = originalCursor && isRecord(originalCursor[part]) ? originalCursor[part] as Record<string, unknown> : undefined;
  }
  if (!targetCursor) return;
  const leaf = parts.at(-1) as string;
  if (originalCursor && Object.prototype.hasOwnProperty.call(originalCursor, leaf)) {
    targetCursor[leaf] = structuredClone(originalCursor[leaf]);
  } else {
    delete targetCursor[leaf];
  }
}

function pruneEmptyObjects(value: Record<string, unknown>): boolean {
  for (const [key, child] of Object.entries(value)) {
    if (isRecord(child) && pruneEmptyObjects(child)) delete value[key];
  }
  return Object.keys(value).length === 0;
}

function gitignoreBlock(): string {
  return '# qwen-harness managed state\n.qwen-harness/install-receipt.json\n.qwen-harness/backups/\n.qwen-harness/state/\n';
}

async function configureGitHubRepository(config: ProjectConfig, dryRun: boolean): Promise<void> {
  if (dryRun) return;
  const labels: Array<[string, string, string]> = [
    [config.intake.readyLabel, '1d76db', 'Normalized task ready for the harness'],
    [config.intake.approvalLabel, '0e8a16', 'Maintainer approved for normalization'],
    [config.intake.normalizedLabel, '5319e7', 'Bot-normalized executable task'],
    [config.intake.communityLabel, 'fbca04', 'Untrusted community signal awaiting maintainer review'],
    [config.intake.planLabel, '8250df', 'Master requirements plan managed by the harness'],
    [config.intake.plannedLabel, 'c5def5', 'Planned story awaiting explicit plan approval'],
    ['self-repair', 'd93f0b', 'Created from reproducible harness feedback'],
  ];
  const existingLabelsResult = await runProcess({
    command: 'gh',
    args: ['label', 'list', '--repo', config.project.githubRepo, '--limit', '1000', '--json', 'name'],
    cwd: config.project.root,
    timeoutMs: 20_000,
  });
  if (existingLabelsResult.exitCode !== 0) {
    throw new Error(`Could not read existing repository labels; no labels were changed: ${existingLabelsResult.stderr}`);
  }
  let existingLabels: Set<string>;
  try {
    existingLabels = new Set(
      (JSON.parse(existingLabelsResult.stdout) as Array<{ name?: string }>).flatMap((label) =>
        typeof label.name === 'string' ? [label.name] : [],
      ),
    );
  } catch {
    throw new Error('GitHub returned invalid label JSON; no labels were changed');
  }
  for (const [name, color, description] of labels) {
    if (existingLabels.has(name)) continue;
    const result = await runProcess({
      command: 'gh',
      args: ['label', 'create', name, '--repo', config.project.githubRepo, '--color', color, '--description', description],
      cwd: config.project.root,
      timeoutMs: 20_000,
    });
    if (result.exitCode !== 0) throw new Error(`Could not configure label ${name}: ${result.stderr}`);
  }
  const protectionEndpoint = `repos/${config.project.githubRepo}/branches/${config.project.defaultBranch}/protection`;
  const existingProtection = await runProcess({
    command: 'gh',
    args: ['api', protectionEndpoint],
    cwd: config.project.root,
    timeoutMs: 30_000,
  });
  const requiredContexts = ['Fern Delivery Harness / CI', 'Fern Delivery Harness / governance', 'Fern Delivery Harness / reward'];
  if (existingProtection.exitCode === 0) {
    let current: { required_status_checks?: { strict?: boolean; contexts?: string[] } | null };
    try {
      current = JSON.parse(existingProtection.stdout) as typeof current;
    } catch {
      throw new Error('GitHub returned invalid branch-protection JSON; existing protection was not changed');
    }
    const missingContexts = requiredContexts.filter(
      (context) => !current.required_status_checks?.contexts?.includes(context),
    );
    if (current.required_status_checks && missingContexts.length === 0) return;
    const statusChecks = current.required_status_checks
      ? { contexts: missingContexts }
      : { strict: true, contexts: requiredContexts };
    const updated = await runProcess({
      command: 'gh',
      args: [
        'api',
        '--method',
        current.required_status_checks ? 'POST' : 'PATCH',
        `${protectionEndpoint}/required_status_checks${current.required_status_checks ? '/contexts' : ''}`,
        '--input',
        '-',
      ],
      cwd: config.project.root,
      input: JSON.stringify(statusChecks),
      timeoutMs: 30_000,
    });
    if (updated.exitCode !== 0) {
      throw new Error(`Could not add harness checks without altering existing branch protection: ${updated.stderr}`);
    }
    return;
  }
  if (!existingProtection.stderr.includes('HTTP 404')) {
    throw new Error(`Could not read existing branch protection; no protection was changed: ${existingProtection.stderr}`);
  }
  const protection = {
    required_status_checks: {
      strict: true,
      contexts: requiredContexts,
    },
    enforce_admins: false,
    required_pull_request_reviews: null,
    restrictions: null,
    required_linear_history: true,
    allow_force_pushes: false,
    allow_deletions: false,
  };
  const result = await runProcess({
    command: 'gh',
    args: ['api', '--method', 'PUT', protectionEndpoint, '--input', '-'],
    cwd: config.project.root,
    input: JSON.stringify(protection),
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) throw new Error(`Could not configure branch protection: ${result.stderr}`);
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) throw new Error(`Harness template assets are missing: ${root}`);
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    return entry.isDirectory() ? listFiles(absolute) : [absolute];
  });
}

function findPackageRoot(): string {
  let cursor = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i += 1) {
    const pkg = path.join(cursor, 'package.json');
    if (existsSync(pkg)) return cursor;
    cursor = path.dirname(cursor);
  }
  throw new Error('Cannot locate qwen-dev-harness package root');
}

async function installImmutableHarnessRuntime(sourceRoot: string): Promise<string> {
  const version = readHarnessVersion(sourceRoot);
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(version)) throw new Error(`Harness version is unsafe for installation: ${version}`);
  const installedRoot = path.join(harnessStateRoot(), 'controller', 'installed', version);
  const installedPackage = path.join(installedRoot, 'node_modules', 'qwen-dev-bot');
  if (existsSync(path.join(installedPackage, 'bin', 'qwen-harness.mjs'))) return installedPackage;
  const parent = path.dirname(installedRoot);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(path.join(parent, `.staging-${version}-`));
  try {
    const packed = await runProcess({
      command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
      args: ['pack', '--json', '--pack-destination', staging, sourceRoot],
      cwd: sourceRoot,
      timeoutMs: 5 * 60_000,
      maxOutputBytes: 5 * 1024 * 1024,
    });
    if (packed.exitCode !== 0) throw new Error(`Could not pack immutable harness runtime: ${packed.stderr || packed.stdout}`);
    const metadata = JSON.parse(packed.stdout) as Array<{ filename?: string }>;
    const filename = metadata[0]?.filename;
    if (!filename || path.basename(filename) !== filename) throw new Error('npm pack did not return a safe archive filename');
    const prefix = path.join(staging, 'runtime');
    const installed = await runProcess({
      command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
      args: ['install', '--prefix', prefix, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', path.join(staging, filename)],
      cwd: staging,
      timeoutMs: 10 * 60_000,
      maxOutputBytes: 10 * 1024 * 1024,
    });
    if (installed.exitCode !== 0) throw new Error(`Could not install immutable harness runtime: ${installed.stderr || installed.stdout}`);
    if (existsSync(installedRoot)) rmSync(installedRoot, { recursive: true, force: true });
    renameSync(prefix, installedRoot);
    if (!existsSync(path.join(installedPackage, 'bin', 'qwen-harness.mjs'))) throw new Error('Immutable harness runtime is incomplete');
    return installedPackage;
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}

async function ensureQwenExtensionLink(command: string, cwd: string, runtimePackageRoot: string): Promise<void> {
  const link = async () => runProcess({
    command,
    args: ['extensions', 'link', runtimePackageRoot],
    cwd,
    input: 'y\n',
    timeoutMs: 60_000,
  });
  const list = async () => runProcess({
    command,
    args: ['extensions', 'list'],
    cwd,
    timeoutMs: 30_000,
  });
  const pointsAtRuntime = (output: string): boolean => {
    const expected = existsSync(runtimePackageRoot) ? realpathSync(runtimePackageRoot) : path.resolve(runtimePackageRoot);
    return output.includes(`Path: ${runtimePackageRoot}`) || output.includes(`Path: ${expected}`);
  };

  const firstLink = await link();
  const firstList = await list();
  if (firstList.exitCode === 0 && pointsAtRuntime(firstList.stdout)) return;

  const existingHarness = firstList.exitCode === 0 && (
    firstList.stdout.includes('qwen-dev-harness') ||
    firstList.stdout.includes('Autonomous Software Delivery Harness')
  );
  if (!existingHarness) {
    const detail = firstLink.stderr || firstLink.stdout || firstList.stderr || firstList.stdout;
    throw new Error(`Qwen extension link failed: ${detail}`);
  }

  const removed = await runProcess({
    command,
    args: ['extensions', 'uninstall', 'qwen-dev-harness'],
    cwd,
    input: 'y\n',
    timeoutMs: 60_000,
  });
  if (removed.exitCode !== 0) throw new Error(`Could not replace the existing Qwen extension link: ${removed.stderr || removed.stdout}`);
  const relinked = await link();
  if (relinked.exitCode !== 0) throw new Error(`Qwen extension relink failed: ${relinked.stderr || relinked.stdout}`);
  const verified = await list();
  if (verified.exitCode !== 0 || !pointsAtRuntime(verified.stdout)) {
    throw new Error('Qwen extension link does not point to the immutable harness runtime. Re-run setup or pass --no-link-extension.');
  }
}

async function detectRepository(root: string): Promise<string> {
  const result = await runProcess({ command: 'git', args: ['remote', 'get-url', 'origin'], cwd: root, timeoutMs: 10_000 });
  if (result.exitCode !== 0) return '';
  const match = /(?:github\.com[:/])([^/]+\/[^/.]+)(?:\.git)?$/.exec(result.stdout.trim());
  return match?.[1] ?? '';
}

async function detectGitHubUser(root: string): Promise<string> {
  const result = await runProcess({ command: 'gh', args: ['api', 'user', '--jq', '.login'], cwd: root, timeoutMs: 10_000 });
  return result.exitCode === 0 ? result.stdout.trim() : '';
}

async function detectQwenVersion(command: string, root: string): Promise<string> {
  const result = await runProcess({ command, args: ['--version'], cwd: root, timeoutMs: 10_000 });
  return result.exitCode === 0 ? result.stdout.trim() || result.stderr.trim() : '';
}

async function resolveQwenRuntime(command: string, root: string): Promise<{ command: string; version: string }> {
  const executable = process.platform === 'win32' ? 'qwen.cmd' : 'qwen';
  const candidates = [command];
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(directory, executable));
  }
  const npmPrefix = await runProcess({
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['prefix', '-g'],
    cwd: root,
    timeoutMs: 10_000,
  });
  if (npmPrefix.exitCode === 0 && npmPrefix.stdout.trim()) {
    candidates.push(
      process.platform === 'win32'
        ? path.join(npmPrefix.stdout.trim(), executable)
        : path.join(npmPrefix.stdout.trim(), 'bin', executable),
    );
  }

  let fallback = { command, version: '' };
  for (const candidate of [...new Set(candidates)]) {
    if (path.isAbsolute(candidate) && !existsSync(candidate)) continue;
    const version = await detectQwenVersion(candidate, root);
    if (!fallback.version && version) fallback = { command: candidate, version };
    if (qwenCodeVersionAtLeast(version)) return { command: candidate, version };
  }
  return fallback;
}

function atomicWrite(file: string, content: Buffer, mode: number): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { mode, flag: 'wx' });
    renameSync(temporary, file);
    chmodSync(file, mode);
  } finally {
    if (existsSync(temporary)) rmSync(temporary);
  }
}

function safeProjectPath(root: string, relative: string): string {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
    throw new Error(`Install receipt contains an unsafe path: ${relative}`);
  }
  const target = path.resolve(root, relative);
  const confined = path.relative(root, target);
  if (!confined || confined.startsWith('..') || path.isAbsolute(confined)) {
    throw new Error(`Install receipt path escapes the project: ${relative}`);
  }
  assertSafeTarget(root, target);
  return target;
}

function assertSafeTarget(root: string, target: string): void {
  const relative = path.relative(root, path.resolve(target));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Managed path escapes the project root: ${target}`);
  }
  let cursor = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`Refusing to follow a symlink in managed path: ${cursor}`);
    }
  }
}

function readHarnessVersion(root: string): string {
  return (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version;
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function deepMerge(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    const current = result[key];
    result[key] =
      current && value && typeof current === 'object' && typeof value === 'object' && !Array.isArray(current) && !Array.isArray(value)
        ? deepMerge(current as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function renderTemplate(source: string, config: ProjectConfig, answers: InstallAnswers): string {
  return source
    .replaceAll('{{PROJECT_NAME}}', config.project.name)
    .replaceAll('{{GITHUB_REPO}}', config.project.githubRepo)
    .replaceAll('{{DEFAULT_BRANCH}}', config.project.defaultBranch)
    .replaceAll('{{NODE_VERSION}}', detectedNodeMajor(config.project.root))
    .replaceAll('{{TRUSTED_AUTHOR}}', answers.trustedAuthor || 'github-actions[bot]');
}

function detectedNodeMajor(root: string): string {
  const packageFile = path.join(root, 'package.json');
  if (!existsSync(packageFile)) return '22';
  try {
    const manifest = JSON.parse(readFileSync(packageFile, 'utf8')) as { engines?: { node?: unknown } };
    const requirement = manifest.engines?.node;
    if (typeof requirement !== 'string') return '22';
    return /\d+/.exec(requirement)?.[0] ?? '22';
  } catch {
    return '22';
  }
}
