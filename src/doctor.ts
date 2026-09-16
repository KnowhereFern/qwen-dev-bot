import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from './core/types.js';
import { PROJECT_CONFIG_PATH } from './core/config.js';
import { redactText } from './core/ledger.js';
import { QwenApiClient } from './qwen/qwen-api.js';
import { qwenCredentialCompatibilityProblem, resolveQwenCredential } from './qwen/credential-resolver.js';
import {
  MIN_QWEN_CODE_VERSION,
  QWEN_MM_CORE_MCP_SERVER,
  qwenCodeVersionAtLeast,
} from './qwen/runtime-compat.js';
import { runProcess } from './runtime/safe-process.js';
import { githubSlugFromRemote } from './git/git-workspace.js';

export type DoctorStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  summary: string;
  details?: string;
}

export interface DoctorReport {
  ready: boolean;
  checks: DoctorCheck[];
}

export async function runDoctor(config: ProjectConfig, options: { live?: boolean } = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const root = config.project.root;
  let qwenExtensions = '';
  checks.push(
    check(
      'node',
      nodeAtLeast(22, 5) ? 'pass' : 'fail',
      `Node ${process.versions.node}`,
      'Node 22.5+ is required for the transactional built-in SQLite store.',
    ),
  );
  checks.push(...(await projectDependencyChecks(config)));
  checks.push(
    check(
      'config',
      existsSync(path.join(root, PROJECT_CONFIG_PATH)) ? 'pass' : 'fail',
      existsSync(path.join(root, PROJECT_CONFIG_PATH)) ? 'Project configuration found' : `Missing ${PROJECT_CONFIG_PATH}`,
    ),
  );

  const git = await commandCheck('git', ['--version'], root);
  checks.push(check('git', git.ok ? 'pass' : 'fail', git.ok ? git.output : 'git is unavailable'));
  if (git.ok) {
    const repo = await commandCheck('git', ['rev-parse', '--is-inside-work-tree'], root);
    checks.push(check('git-repository', repo.ok ? 'pass' : 'fail', repo.ok ? 'Git repository detected' : 'Target is not a Git repository'));
    if (repo.ok) {
      const clean = await commandCheck('git', ['status', '--porcelain=v1'], root);
      checks.push(check('clean-checkout', clean.ok && !clean.output ? 'pass' : 'fail', clean.output ? 'Checkout has uncommitted changes' : 'Checkout is clean'));
      const remote = await commandCheck('git', ['remote', 'get-url', 'origin'], root);
      checks.push(check('git-origin', remote.ok ? 'pass' : 'fail', remote.ok ? `origin: ${remote.output}` : 'Git remote origin is missing'));
      if (remote.ok) {
        const slug = githubSlugFromRemote(remote.output);
        const localRemote = !/^[a-z][a-z0-9+.-]*:\/\//i.test(remote.output) && !remote.output.startsWith('git@');
        const identityMatches = slug?.toLowerCase() === config.project.githubRepo.toLowerCase();
        checks.push(
          check(
            'git-origin-identity',
            identityMatches || localRemote ? 'pass' : 'fail',
            identityMatches
              ? `origin matches ${config.project.githubRepo}`
              : localRemote
                ? 'Local Git remote detected (test/development mode)'
                : `origin does not match ${config.project.githubRepo}`,
          ),
        );
        const remoteHead = await commandCheck(
          'git',
          ['ls-remote', '--exit-code', 'origin', `refs/heads/${config.project.defaultBranch}`],
          root,
        );
        checks.push(
          check(
            'git-remote-access',
            remoteHead.ok ? 'pass' : 'fail',
            remoteHead.ok ? `origin/${config.project.defaultBranch} is readable` : 'Cannot read the configured default branch from origin',
          ),
        );
      }
    }
  }

  const gh = await commandCheck('gh', ['auth', 'status'], root);
  checks.push(check('github-auth', gh.ok ? 'pass' : 'fail', gh.ok ? 'GitHub CLI authenticated' : 'Run `gh auth login`'));
  if (gh.ok && config.project.githubRepo) {
    const repoRead = await commandCheck('gh', ['api', `repos/${config.project.githubRepo}`, '--jq', '.full_name'], root);
    checks.push(check('github-repository', repoRead.ok ? 'pass' : 'fail', repoRead.ok ? `GitHub access: ${repoRead.output}` : 'Cannot read configured GitHub repository'));
    const protection = await commandCheck(
      'gh',
      ['api', `repos/${config.project.githubRepo}/branches/${config.project.defaultBranch}/protection`, '--jq', '.required_status_checks.contexts'],
      root,
    );
    checks.push(check('branch-protection', protection.ok ? 'pass' : config.worker.autoMerge ? 'fail' : 'warn', protection.ok ? 'Branch protection is readable' : 'Branch protection is absent or unavailable'));
  }

  const qwen = await commandCheck(config.qwen.command, ['--version'], root);
  const qwenCompatible = qwen.ok && qwenCodeVersionAtLeast(qwen.output);
  checks.push(
    check(
      'qwen-code',
      qwenCompatible ? 'pass' : 'fail',
      qwen.ok ? `Qwen Code ${qwen.output}` : 'Qwen Code is unavailable',
      qwen.ok && !qwenCompatible
        ? `Qwen Code ${MIN_QWEN_CODE_VERSION}+ is required for durable headless Goal controls.`
        : undefined,
    ),
  );
  if (qwen.ok) {
    const features = await commandCheck(
      config.qwen.command,
      ['--help'],
      root,
      true,
    );
    const requiredHeadlessFlags = [
      '--approval-mode',
      '--max-wall-time',
      '--max-tool-calls',
      '--max-session-turns',
      '--max-subagent-depth',
      '--allowed-tools',
      '--json-schema',
      '--allowed-mcp-server-names',
    ];
    const featuresPresent =
      features.ok && requiredHeadlessFlags.every((flag) => features.output.includes(flag));
    checks.push(
      check(
        'qwen-headless-features',
        featuresPresent && qwenCompatible ? 'pass' : 'fail',
        featuresPresent && qwenCompatible
          ? 'Headless Goal controls, budgets, structured output, and MCP scoping supported'
          : 'Installed Qwen Code lacks the required durable headless feature set',
      ),
    );
    const extensions = await commandCheck(config.qwen.command, ['extensions', 'list'], root, true);
    qwenExtensions = extensions.output;
    const harnessExtensionPresent = extensions.ok && qwenHarnessExtensionPresent(extensions.output);
    checks.push(check('qwen-extension', harnessExtensionPresent ? 'pass' : 'warn', harnessExtensionPresent ? 'Harness extension installed' : 'Harness extension is not linked; run setup/update'));
  }

  const harnessCli = await commandCheck(process.platform === 'win32' ? 'qwen-harness.cmd' : 'qwen-harness', ['--version'], root);
  checks.push(
    check(
      'harness-cli',
      harnessCli.ok ? 'pass' : 'warn',
      harnessCli.ok ? `qwen-harness ${harnessCli.output}` : 'qwen-harness is not on PATH; use this checkout\'s npm run harness command or rerun setup with --install-cli',
    ),
  );

  const credential = resolveQwenCredential(config);
  const apiKeyPresent = Boolean(credential);
  checks.push(
    check(
      'qwen-api-key',
      apiKeyPresent ? 'pass' : 'fail',
      credential
        ? `${config.qwen.credentialEnvKey} is available from ${credential.source}`
        : `Configure ${config.qwen.credentialEnvKey} in Qwen user settings, ~/.qwen/.env, the shell, or the worker environment`,
    ),
  );
  if (credential) {
    const compatibilityProblem = qwenCredentialCompatibilityProblem(config, credential);
    checks.push(
      check(
        'qwen-billing-route',
        compatibilityProblem ? 'fail' : config.qwen.billingPlan === 'custom' ? 'warn' : 'pass',
        compatibilityProblem ??
          (config.qwen.billingPlan === 'custom'
            ? 'Custom Qwen billing route selected; verify its credential and endpoint compatibility'
            : `${config.qwen.billingPlan} credential family and endpoint are consistent`),
      ),
    );
  }
  checks.push(sandboxCheck(config));

  const assetProblems = templateAssetProblems(root);
  checks.push(
    check(
      'template-assets',
      assetProblems.length === 0 ? 'pass' : 'fail',
      assetProblems.length === 0 ? 'GitHub/Qwen template assets installed and recognizable' : assetProblems.join('; '),
    ),
  );
  checks.push(qwenProjectSettingsCheck(config));

  const multimodalAllowed = config.qwen.allowedMcpServers.includes(QWEN_MM_CORE_MCP_SERVER);
  const needsVisual =
    config.rewards.criteria.some((criterion) => criterion.modality === 'visual') || multimodalAllowed;
  if (needsVisual) {
    const mmPresent = qwenExtensions.includes('qwen-mm-plugins-core');
    checks.push(
      check(
        'qwen-mm-plugins',
        mmPresent ? 'pass' : 'warn',
        mmPresent
          ? 'Qwen-MM-Plugins core capability detected'
          : 'Visual reward scoring works through the Qwen API; install Qwen-MM-Plugins core to give implementation agents native visual tools',
      ),
    );
  }
  if (multimodalAllowed) {
    const uvx = await commandCheck('uvx', ['--version'], root);
    checks.push(
      check(
        'qwen-mm-runtime',
        uvx.ok ? 'pass' : 'fail',
        uvx.ok ? `Qwen-MM runtime available: ${uvx.output}` : 'Qwen-MM core requires uv/uvx; install it from https://docs.astral.sh/uv/',
      ),
    );
  }

  if (options.live && credential) {
    try {
      const api = new QwenApiClient({
        model: config.qwen.model,
        apiKey: credential.apiKey,
        credentialEnvKey: config.qwen.credentialEnvKey,
        baseUrl: config.qwen.baseUrl,
      });
      const result = await api.completeJson<{ ok: boolean }>({
        system: 'Return JSON only.',
        user: 'Return {"ok":true}.',
        reasoningEffort: 'low',
        maxTokens: 32,
      });
      checks.push(check('qwen-live', result.value.ok === true ? 'pass' : 'fail', result.value.ok === true ? 'Live Qwen3.8-Max call passed' : 'Live Qwen response failed validation'));
    } catch (error) {
      checks.push(check('qwen-live', 'fail', 'Live Qwen3.8-Max call failed', error instanceof Error ? error.message : String(error)));
    }
  }

  return { ready: checks.every((item) => item.status !== 'fail'), checks };
}

export function qwenHarnessExtensionPresent(output: string): boolean {
  return output.includes('qwen-dev-harness') || output.includes('Autonomous Software Delivery Harness');
}

export function formatDoctor(report: DoctorReport): string {
  const icon: Record<DoctorStatus, string> = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' };
  return [
    ...report.checks.map((item) => `${icon[item.status].padEnd(4)}  ${item.id.padEnd(24)} ${item.summary}${item.details && item.status !== 'pass' ? `\n      ${item.details}` : ''}`),
    '',
    report.ready ? 'READY: harness prerequisites are satisfied.' : 'NOT READY: resolve FAIL checks before unattended execution.',
  ].join('\n');
}

function sandboxCheck(config: ProjectConfig): DoctorCheck {
  if (!config.qwen.sandbox) return check('sandbox', 'fail', 'Qwen sandbox is disabled');
  if (process.platform === 'darwin') return check('sandbox', existsSync('/usr/bin/sandbox-exec') ? 'pass' : 'warn', existsSync('/usr/bin/sandbox-exec') ? 'macOS Seatbelt available' : 'Seatbelt unavailable; configure Docker/Podman');
  return check('sandbox', 'pass', 'Sandbox required; Qwen Code will validate Docker/Podman when a run starts');
}

async function commandCheck(
  command: string,
  args: string[],
  cwd: string,
  fullOutput = false,
): Promise<{ ok: boolean; output: string }> {
  const receipt = await runProcess({ command, args, cwd, timeoutMs: 20_000, maxOutputBytes: 2 * 1024 * 1024 });
  const output = receipt.stdout.trim() || receipt.stderr.trim();
  return { ok: receipt.exitCode === 0, output: fullOutput ? output : output.split('\n')[0] ?? '' };
}

function check(id: string, status: DoctorStatus, summary: string, details?: string): DoctorCheck {
  return {
    id,
    status,
    summary: redactText(summary),
    ...(details ? { details: redactText(details) } : {}),
  };
}

function nodeAtLeast(major: number, minor: number): boolean {
  const [currentMajor, currentMinor] = process.versions.node.split('.').map(Number);
  return currentMajor > major || (currentMajor === major && currentMinor >= minor);
}

export async function projectDependencyChecks(config: ProjectConfig): Promise<DoctorCheck[]> {
  const root = config.project.root;
  const checks: DoctorCheck[] = [];
  const packageFile = path.join(root, 'package.json');
  let packages = new Set<string>();

  if (existsSync(packageFile)) {
    try {
      const manifest = JSON.parse(readFileSync(packageFile, 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };
      packages = new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
        ...Object.keys(manifest.optionalDependencies ?? {}),
      ]);
      const manager = nodePackageManager(root);
      if (!manager && packages.size > 0) {
        checks.push(check('dependency-lock', 'fail', 'Node dependencies are declared but no supported lockfile exists', 'Commit package-lock.json, pnpm-lock.yaml, yarn.lock, or bun.lock/bun.lockb.'));
      } else if (!manager) {
        checks.push(check('node-dependencies', 'pass', 'No external Node packages are declared'));
      } else {
        checks.push(
          check(
            'package-manager',
            commandAvailable(manager.command, root) ? 'pass' : 'fail',
            commandAvailable(manager.command, root)
              ? `${manager.name} selected by ${manager.lockfile}`
              : `${manager.name} is required by ${manager.lockfile} but is not on PATH`,
          ),
        );
        if (!existsSync(path.join(root, 'node_modules'))) {
          checks.push(check('node-dependencies', 'fail', 'Node dependencies are not installed', 'Run .qwen-harness/scripts/bootstrap.mjs.'));
        } else {
          const installed = await commandCheck(manager.command, manager.checkArgs, root, true);
          checks.push(
            check(
              'node-dependencies',
              installed.ok ? 'pass' : 'fail',
              installed.ok ? 'Installed Node dependency tree matches the project manifest' : 'Installed Node dependencies are missing or invalid',
              installed.ok ? undefined : `${installed.output.slice(0, 1_000)}\nRun .qwen-harness/scripts/bootstrap.mjs.`,
            ),
          );
        }
      }
    } catch (error) {
      checks.push(check('node-dependencies', 'fail', 'package.json is not valid JSON', error instanceof Error ? error.message : String(error)));
    }
  }

  const uvLock = path.join(root, 'uv.lock');
  const requirements = path.join(root, 'requirements.txt');
  if (existsSync(uvLock)) {
    const uv = await commandCheck('uv', ['--version'], root);
    checks.push(check('python-dependencies', uv.ok ? 'pass' : 'fail', uv.ok ? `uv lockfile runtime available: ${uv.output}` : 'uv.lock exists but uv is unavailable'));
  } else if (existsSync(requirements)) {
    const pythonCommand = process.platform === 'win32' ? 'python' : 'python3';
    const python = await commandCheck(pythonCommand, ['--version'], root);
    checks.push(check('python-runtime', python.ok ? 'pass' : 'fail', python.ok ? python.output : `${pythonCommand} is required by requirements.txt`));
    const venvPython = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const dependencies = existsSync(venvPython)
      ? await commandCheck(venvPython, ['-m', 'pip', 'check'], root, true)
      : { ok: false, output: '' };
    checks.push(
      check(
        'python-dependencies',
        dependencies.ok ? 'pass' : 'fail',
        dependencies.ok ? 'Project-local Python dependency environment is consistent' : 'Project-local .venv is missing or inconsistent',
        dependencies.ok ? undefined : 'Run .qwen-harness/scripts/bootstrap.mjs.',
      ),
    );
  }

  const missingGateCommands = [...new Set(config.gates.map((gate) => gate.command))].filter(
    (command) => !commandAvailable(command, root),
  );
  checks.push(
    check(
      'gate-runtimes',
      missingGateCommands.length === 0 ? 'pass' : 'fail',
      missingGateCommands.length === 0
        ? 'Every configured gate executable is available'
        : `Missing gate executable(s): ${missingGateCommands.join(', ')}`,
    ),
  );

  const playwrightDeclared = packages.has('@playwright/test') || packages.has('playwright');
  const cypressDeclared = packages.has('cypress');
  if (playwrightDeclared) {
    const binary = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'playwright.cmd' : 'playwright');
    if (!existsSync(binary)) {
      checks.push(check('browser-runtime', 'fail', 'Playwright is declared but its local CLI is not installed', 'Run .qwen-harness/scripts/bootstrap.mjs.'));
    } else {
      const browsers = await commandCheck(binary, ['install', '--list'], root, true);
      checks.push(
        check(
          'browser-runtime',
          browsers.ok && browsers.output.trim().length > 0 ? 'pass' : 'fail',
          browsers.ok && browsers.output.trim().length > 0
            ? 'Playwright package and matching browser binaries are installed'
            : 'Playwright browser binaries are missing',
          browsers.ok && browsers.output.trim().length > 0 ? undefined : 'Run .qwen-harness/scripts/bootstrap.mjs to install browsers for the locked Playwright version.',
        ),
      );
    }
  } else if (cypressDeclared) {
    const binary = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'cypress.cmd' : 'cypress');
    const verified = existsSync(binary) ? await commandCheck(binary, ['verify'], root, true) : { ok: false, output: '' };
    checks.push(check('browser-runtime', verified.ok ? 'pass' : 'fail', verified.ok ? 'Cypress package and browser runtime are verified' : 'Cypress runtime is missing or unverified', verified.ok ? undefined : 'Run .qwen-harness/scripts/bootstrap.mjs.'));
  } else if (config.rewards.criteria.some((criterion) => criterion.modality === 'visual')) {
    checks.push(check('browser-runtime', 'warn', 'Visual scoring is configured without a declared Playwright or Cypress package', 'A custom gate may still produce the required artifacts; otherwise add project-local browser automation.'));
  }

  return checks;
}

function nodePackageManager(root: string): { name: string; command: string; lockfile: string; checkArgs: string[] } | null {
  const candidates = [
    { name: 'npm', command: process.platform === 'win32' ? 'npm.cmd' : 'npm', lockfile: 'package-lock.json', checkArgs: ['ls', '--depth=0'] },
    { name: 'npm', command: process.platform === 'win32' ? 'npm.cmd' : 'npm', lockfile: 'npm-shrinkwrap.json', checkArgs: ['ls', '--depth=0'] },
    { name: 'pnpm', command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', lockfile: 'pnpm-lock.yaml', checkArgs: ['list', '--depth=0'] },
    { name: 'Yarn', command: process.platform === 'win32' ? 'yarn.cmd' : 'yarn', lockfile: 'yarn.lock', checkArgs: ['list', '--depth=0'] },
    { name: 'Bun', command: process.platform === 'win32' ? 'bun.exe' : 'bun', lockfile: existsSync(path.join(root, 'bun.lock')) ? 'bun.lock' : 'bun.lockb', checkArgs: ['pm', 'ls'] },
  ];
  return candidates.find((candidate) => existsSync(path.join(root, candidate.lockfile))) ?? null;
}

function commandAvailable(command: string, root: string): boolean {
  if (path.isAbsolute(command)) return existsSync(command);
  if (command.includes('/') || command.includes('\\')) return existsSync(path.resolve(root, command));
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .some((directory) => extensions.some((extension) => existsSync(path.join(directory, `${command}${extension}`))));
}

export function templateAssetProblems(root: string): string[] {
  const requirements: Array<[string, string[]]> = [
    ['AUTONOMY.md', ['## Delivery invariant', '## Required loop']],
    ['QWEN.md', ['The external supervisor', 'harness-implement.js']],
    ['.github/CODEOWNERS', ['/.qwen-harness/', '/.qwen/workflows/harness-*']],
    ['.github/ISSUE_TEMPLATE/harness-task.yml', ['Harness improvement request', 'harness:accept']],
    ['.github/workflows/harness-ci.yml', ['Fern Delivery Harness / CI', 'run-gates.mjs', 'persist-credentials: false']],
    ['.github/workflows/harness-dispatch.yml', ['Fern Delivery Harness Dispatch Health', 'harness:ready']],
    ['.github/workflows/harness-governance.yml', ['Fern Delivery Harness / governance', 'check-governance.mjs', 'persist-credentials: false']],
    ['.github/workflows/harness-intake.yml', ['Fern Delivery Harness Intake', 'harness:accept']],
    ['.github/workflows/harness-postmerge.yml', ['Fern Delivery Harness Post-merge Repair', 'self-repair']],
    ['.qwen-harness/scripts/bootstrap.mjs', ["spawn(command, args", 'shell: false', 'terminateTree', 'declaredNodePackages', "['install', '--list']"]],
    ['.qwen-harness/scripts/check-governance.mjs', ['--name-status', '--find-renames']],
    ['.qwen-harness/scripts/run-gates.mjs', ['config.gates', 'timeoutMs', 'terminateTree']],
    ['.qwen/workflows/harness-implement.js', ['harness-implementer', 'harness-reviewer']],
    ['.qwen/skills/harness-reward/SKILL.md', ['name: harness-reward', 'Hard failures cannot be compensated']],
  ];
  for (const agent of ['implementer', 'recovery', 'researcher', 'reviewer', 'verifier', 'visual-reviewer']) {
    requirements.push([
      `.qwen/agents/harness-${agent}.md`,
      [`name: harness-${agent}`, ...(agent === 'implementer' ? ['approvalMode: yolo'] : [])],
    ]);
  }
  const problems: string[] = [];
  for (const [relative, markers] of requirements) {
    const file = path.join(root, relative);
    if (!existsSync(file)) {
      problems.push(`missing ${relative}`);
      continue;
    }
    const content = readFileSync(file, 'utf8');
    const missingMarkers = markers.filter((marker) => !content.includes(marker));
    if (missingMarkers.length > 0) problems.push(`incompatible ${relative}`);
  }
  return problems;
}

function qwenProjectSettingsCheck(config: ProjectConfig): DoctorCheck {
  const file = path.join(config.project.root, '.qwen', 'settings.json');
  if (!existsSync(file)) return check('qwen-project-settings', 'fail', 'Missing .qwen/settings.json');
  try {
    const settings = JSON.parse(readFileSync(file, 'utf8')) as {
      model?: { name?: string; maxSubagentDepth?: number };
      tools?: { workflowsEnabled?: boolean; sandbox?: boolean; computerUse?: { enabled?: boolean } };
      mcp?: { allowed?: string[] };
      modelProviders?: { openai?: Array<{ id?: string; baseUrl?: string; envKey?: string }> };
      security?: { auth?: { selectedType?: string } };
    };
    const provider = settings.modelProviders?.openai?.find(
      (candidate) => candidate.id === config.qwen.model && candidate.baseUrl === config.qwen.baseUrl,
    );
    const valid =
      settings.model?.name === config.qwen.model &&
      settings.model?.maxSubagentDepth === 1 &&
      settings.tools?.workflowsEnabled === true &&
      settings.tools?.sandbox === true &&
      settings.tools?.computerUse?.enabled === false &&
      Array.isArray(settings.mcp?.allowed) &&
      settings.mcp.allowed.length === config.qwen.allowedMcpServers.length &&
      settings.mcp.allowed.every((server) => config.qwen.allowedMcpServers.includes(server)) &&
      settings.security?.auth?.selectedType === 'openai' &&
      provider?.envKey === config.qwen.credentialEnvKey;
    return check(
      'qwen-project-settings',
      valid ? 'pass' : 'fail',
      valid
        ? 'Qwen3.8-Max provider, sandboxed leaf delegation, workflows, credential reference, and native computer-use boundary configured'
        : 'Project Qwen provider settings do not match the harness configuration',
    );
  } catch {
    return check('qwen-project-settings', 'fail', '.qwen/settings.json is not valid JSON');
  }
}
