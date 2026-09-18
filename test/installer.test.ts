import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { githubBranchProtectionUnavailable, installProject, uninstallProject } from '../src/installer/installer.js';
import { defaultProjectConfig, serializeProjectConfig } from '../src/core/config.js';
import { templateAssetProblems } from '../src/doctor.js';
import { runProcess } from '../src/runtime/safe-process.js';
import { makeTmp } from './helpers.js';

const harnessVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string;

const priorState = process.env.QWEN_HARNESS_STATE_DIR;
afterEach(() => {
  if (priorState === undefined) delete process.env.QWEN_HARNESS_STATE_DIR;
  else process.env.QWEN_HARNESS_STATE_DIR = priorState;
});

describe('guided installer', () => {
  it('recognizes GitHub plan limits without hiding unrelated protection failures', () => {
    expect(githubBranchProtectionUnavailable('Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)')).toBe(true);
    expect(githubBranchProtectionUnavailable('branch protection is not available for this repository')).toBe(true);
    expect(githubBranchProtectionUnavailable('HTTP 500')).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('selects a compatible Qwen binary when PATH shadows it with an older copy', async () => {
    const root = makeTmp('installer-qwen-path');
    const oldBin = makeTmp('installer-qwen-old-bin');
    const currentBin = makeTmp('installer-qwen-current-bin');
    process.env.QWEN_HARNESS_STATE_DIR = makeTmp('installer-qwen-path-state');
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
    writeFileSync(path.join(oldBin, 'qwen'), '#!/bin/sh\necho 0.22.0\n');
    writeFileSync(path.join(currentBin, 'qwen'), '#!/bin/sh\necho 0.22.1\n');
    chmodSync(path.join(oldBin, 'qwen'), 0o755);
    chmodSync(path.join(currentBin, 'qwen'), 0o755);
    const priorPath = process.env.PATH;
    process.env.PATH = [oldBin, currentBin, priorPath].filter(Boolean).join(path.delimiter);
    try {
      const result = await installProject({
        root,
        yes: true,
        answers: {
          projectName: 'fixture',
          githubRepo: 'owner/fixture',
          trustedAuthor: 'owner',
          installQwen: false,
          linkExtension: false,
          installService: false,
          bootstrapDependencies: false,
          configureGitHub: false,
        },
      });
      expect(result.config.qwen.command).toBe(path.join(currentBin, 'qwen'));
      expect(result.config.worker.autoMerge).toBe(true);
    } finally {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
    }
  });

  it('configures Token Plan Personal with its matching credential and endpoint', async () => {
    const root = makeTmp('installer-personal-plan');
    process.env.QWEN_HARNESS_STATE_DIR = makeTmp('installer-personal-plan-state');
    const result = await installProject({
      root,
      yes: true,
      answers: {
        projectName: 'fixture',
        githubRepo: 'owner/fixture',
        trustedAuthor: 'owner',
        qwenBillingPlan: 'token-plan-personal',
        linkExtension: false,
        installService: false,
        bootstrapDependencies: false,
        configureGitHub: false,
      },
    });

    expect(result.config.qwen.billingPlan).toBe('token-plan-personal');
    expect(result.config.qwen.credentialEnvKey).toBe('BAILIAN_TOKEN_PLAN_API_KEY');
    expect(result.config.qwen.baseUrl).toBe('https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1');
  });

  it('installs idempotently and preserves modified files on uninstall', async () => {
    const root = makeTmp('installer-project');
    process.env.QWEN_HARNESS_STATE_DIR = makeTmp('installer-state');
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'fixture',
      engines: { node: '>=24' },
      scripts: { test: 'node --test' },
    }));
    writeFileSync(path.join(root, '.gitignore'), 'coverage/\n');
    const options = {
      root,
      yes: true,
      answers: {
        projectName: 'fixture',
        githubRepo: 'owner/fixture',
        trustedAuthor: 'owner',
        qwenBaseUrl: 'https://qwen.example.test/compatible-mode/v1',
        autoMerge: false,
        linkExtension: false,
        installService: false,
        configureGitHub: false,
      },
    };
    await installProject(options);
    const configFile = path.join(root, '.qwen-harness', 'project.yml');
    const customized = JSON.parse(readFileSync(configFile, 'utf8'));
    customized.project.defaultBranch = 'develop';
    customized.gates.push({
      id: 'custom-proof',
      kind: 'custom',
      command: 'node',
      args: ['proof.mjs'],
      required: true,
      timeoutMs: 1_000,
    });
    writeFileSync(configFile, `${JSON.stringify(customized, null, 2)}\n`);
    const settingsFile = path.join(root, '.qwen', 'settings.json');
    const customizedSettings = JSON.parse(readFileSync(settingsFile, 'utf8'));
    customizedSettings.modelProviders.openai.unshift({
      id: 'another-model',
      name: 'Existing project provider',
      baseUrl: 'https://provider.example.test/v1',
      envKey: 'ANOTHER_API_KEY',
    });
    writeFileSync(settingsFile, `${JSON.stringify(customizedSettings, null, 2)}\n`);
    await installProject(options);
    expect(existsSync(path.join(root, '.github', 'workflows', 'harness-ci.yml'))).toBe(true);
    expect(existsSync(path.join(root, '.qwen', 'workflows', 'harness-implement.js'))).toBe(true);
    const installedConfig = JSON.parse(readFileSync(configFile, 'utf8'));
    expect(installedConfig.qwen.model).toBe('qwen3.8-max');
    expect(installedConfig.qwen.baseUrl).toBe('https://qwen.example.test/compatible-mode/v1');
    expect(installedConfig.worker.autoMerge).toBe(false);
    expect(installedConfig.qwen.allowedMcpServers).toEqual([]);
    expect(installedConfig.project.defaultBranch).toBe('develop');
    expect(installedConfig.gates.some((gate: { id: string }) => gate.id === 'custom-proof')).toBe(true);
    expect(readFileSync(path.join(root, '.github', 'workflows', 'harness-ci.yml'), 'utf8')).toContain('branches: ["develop"]');
    expect(readFileSync(path.join(root, '.github', 'workflows', 'harness-ci.yml'), 'utf8')).toContain('node-version: 24');
    expect(readFileSync(path.join(root, '.gitignore'), 'utf8').match(/qwen-harness managed state/g)).toHaveLength(1);
    const installedSettings = JSON.parse(readFileSync(settingsFile, 'utf8'));
    expect(installedSettings.security.auth.selectedType).toBe('openai');
    expect(installedSettings.model.maxSubagentDepth).toBe(1);
    expect(installedSettings.tools).toMatchObject({
      sandbox: true,
      workflowsEnabled: true,
      computerUse: { enabled: false },
    });
    expect(installedSettings.mcp.allowed).toEqual([]);
    expect(installedSettings.modelProviders.openai).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'another-model' }),
        expect.objectContaining({
          id: 'qwen3.8-max',
          baseUrl: 'https://qwen.example.test/compatible-mode/v1',
          envKey: 'DASHSCOPE_API_KEY',
        }),
      ]),
    );
    expect(templateAssetProblems(root)).toEqual([]);

    const workflow = path.join(root, '.github', 'workflows', 'harness-ci.yml');
    writeFileSync(workflow, `${readFileSync(workflow, 'utf8')}# user customization\n`);
    const actions = await uninstallProject(root);
    expect(actions).toContain('kept modified .github/workflows/harness-ci.yml');
    expect(existsSync(workflow)).toBe(true);
    expect(existsSync(path.join(root, 'AUTONOMY.md'))).toBe(false);
    expect(existsSync(configFile)).toBe(true);
    expect(JSON.parse(readFileSync(configFile, 'utf8')).project.defaultBranch).toBe('develop');
    const uninstalledSettings = JSON.parse(readFileSync(settingsFile, 'utf8'));
    expect(uninstalledSettings.modelProviders.openai).toEqual([
      expect.objectContaining({ id: 'another-model' }),
    ]);
    expect(uninstalledSettings.modelProviders.openai).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'qwen3.8-max' })]),
    );
    expect(readFileSync(path.join(root, '.gitignore'), 'utf8')).not.toContain('qwen-harness managed state');
  });

  it('allows only the installed Qwen multimodal MCP capability when requested', async () => {
    const root = makeTmp('installer-mm-project');
    process.env.QWEN_HARNESS_STATE_DIR = makeTmp('installer-mm-state');
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));

    const result = await installProject({
      root,
      dryRun: true,
      yes: true,
      answers: {
        projectName: 'fixture',
        githubRepo: 'owner/fixture',
        trustedAuthor: 'owner',
        installMultimodal: true,
        linkExtension: false,
        installService: false,
        configureGitHub: false,
      },
    });

    expect(result.config.qwen.allowedMcpServers).toEqual(['qwen-mm-plugins-core']);
  });

  it('preserves prior external setup receipts when an update skips those steps', async () => {
    const root = makeTmp('installer-external-receipt');
    process.env.QWEN_HARNESS_STATE_DIR = makeTmp('installer-external-receipt-state');
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
    const answers = {
      projectName: 'fixture',
      githubRepo: 'owner/fixture',
      trustedAuthor: 'owner',
      linkExtension: false,
      installService: false,
      configureGitHub: false,
    };
    await installProject({ root, yes: true, answers });
    const receiptFile = path.join(root, '.qwen-harness', 'install-receipt.json');
    const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
    receipt.extensionLinked = true;
    receipt.service = {
      platform: process.platform,
      file: '/managed/service',
      envFile: '/managed/worker.env',
      credentialsPersisted: true,
      installed: true,
      message: 'installed',
    };
    writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);

    const updated = await installProject({ root, yes: true, answers });
    expect(updated.receipt.extensionLinked).toBe(true);
    expect(updated.receipt.service).toEqual(receipt.service);
  });

  it('restores pre-existing Qwen settings while preserving later unrelated additions', async () => {
    const root = makeTmp('installer-existing-settings');
    process.env.QWEN_HARNESS_STATE_DIR = makeTmp('installer-existing-settings-state');
    const settingsFile = path.join(root, '.qwen', 'settings.json');
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
    mkdirSync(path.dirname(settingsFile), { recursive: true });
    writeFileSync(
      settingsFile,
      `${JSON.stringify({
        model: { name: 'existing-model' },
        tools: { approvalMode: 'default', customToolSetting: true },
        general: { chatRecording: false },
        security: { auth: { selectedType: 'oauth', tenant: 'existing' } },
        modelProviders: {
          openai: [
            {
              id: 'existing-model',
              name: 'Existing provider',
              baseUrl: 'https://existing.example.test/v1',
              envKey: 'EXISTING_API_KEY',
            },
          ],
        },
      }, null, 2)}\n`,
    );
    const options = {
      root,
      yes: true,
      answers: {
        projectName: 'fixture',
        githubRepo: 'owner/fixture',
        trustedAuthor: 'owner',
        linkExtension: false,
        installService: false,
        configureGitHub: false,
      },
    };
    await installProject(options);
    const customized = JSON.parse(readFileSync(settingsFile, 'utf8'));
    customized.lateAddition = { keep: true };
    writeFileSync(settingsFile, `${JSON.stringify(customized, null, 2)}\n`);
    await installProject(options);
    await uninstallProject(root);

    const restored = JSON.parse(readFileSync(settingsFile, 'utf8'));
    expect(restored.model.name).toBe('existing-model');
    expect(restored.tools).toEqual({ approvalMode: 'default', customToolSetting: true });
    expect(restored.general.chatRecording).toBe(false);
    expect(restored.security.auth).toEqual({ selectedType: 'oauth', tenant: 'existing' });
    expect(restored.modelProviders.openai).toEqual([
      expect.objectContaining({ id: 'existing-model' }),
    ]);
    expect(restored.lateAddition).toEqual({ keep: true });
  });

  it('launches the packaged CLI outside the harness checkout', async () => {
    const cwd = makeTmp('launcher-cwd');
    const receipt = await runProcess({
      command: process.execPath,
      args: [path.resolve('bin/qwen-harness.mjs'), '--version'],
      cwd,
      timeoutMs: 20_000,
    });
    expect(receipt.exitCode).toBe(0);
    expect(receipt.stdout.trim()).toBe(harnessVersion);
  });

  it.skipIf(process.platform === 'win32')('replaces a stale extension link with the immutable runtime', async () => {
    const root = makeTmp('installer-extension-project');
    const state = makeTmp('installer-extension-state');
    const bin = makeTmp('installer-extension-bin');
    const linkedPath = path.join(state, 'linked-path');
    const qwen = path.join(bin, 'qwen');
    process.env.QWEN_HARNESS_STATE_DIR = state;
    writeFileSync(linkedPath, '/old/development/checkout');
    writeFileSync(qwen, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 0.23.3; exit 0; fi
if [ "$1" = "extensions" ] && [ "$2" = "list" ]; then
  echo "Autonomous Software Delivery Harness"
  echo " Path: $(cat "${linkedPath}")"
  exit 0
fi
if [ "$1" = "extensions" ] && [ "$2" = "link" ]; then
  if [ -f "${linkedPath}" ]; then echo already linked >&2; exit 1; fi
  printf '%s' "$3" > "${linkedPath}"
  exit 0
fi
if [ "$1" = "extensions" ] && [ "$2" = "uninstall" ]; then rm -f "${linkedPath}"; exit 0; fi
exit 1
`);
    chmodSync(qwen, 0o755);
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
    const config = defaultProjectConfig(root, 'fixture', 'owner/fixture');
    config.qwen.command = qwen;
    const configFile = path.join(root, '.qwen-harness', 'project.yml');
    mkdirSync(path.dirname(configFile), { recursive: true });
    writeFileSync(configFile, serializeProjectConfig(config));

    const installed = await installProject({
      root,
      yes: true,
      answers: {
        projectName: 'fixture',
        githubRepo: 'owner/fixture',
        trustedAuthor: 'owner',
        linkExtension: true,
        installService: false,
        bootstrapDependencies: false,
        configureGitHub: false,
      },
    });

    const immutableRuntime = path.join(state, 'controller', 'installed', harnessVersion, 'node_modules', 'qwen-dev-bot');
    expect(readFileSync(linkedPath, 'utf8')).toBe(immutableRuntime);
    expect(installed.receipt.extensionLinked).toBe(true);
  }, 15_000);

  it('shows setup help without entering the interactive wizard', async () => {
    const cwd = makeTmp('launcher-help-cwd');
    const receipt = await runProcess({
      command: process.execPath,
      args: [path.resolve('bin/qwen-harness.mjs'), 'init', '--help'],
      cwd,
      timeoutMs: 20_000,
    });
    expect(receipt.exitCode).toBe(0);
    expect(receipt.stdout).toContain('Guided, idempotent project setup');
    expect(receipt.stdout).toContain('--link-extension --no-link-extension');
    expect(receipt.stdout).not.toContain('Project name [');
  });

  it('leaves a recovery receipt when an optional external setup step fails', async () => {
    const root = makeTmp('installer-partial-failure');
    const state = makeTmp('installer-partial-failure-state');
    process.env.QWEN_HARNESS_STATE_DIR = state;
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
    const config = defaultProjectConfig(root, 'fixture', 'owner/fixture');
    config.qwen.command = 'qwen-command-that-does-not-exist';
    const configFile = path.join(root, '.qwen-harness', 'project.yml');
    mkdirSync(path.dirname(configFile), { recursive: true });
    writeFileSync(configFile, serializeProjectConfig(config));

    await expect(
      installProject({
        root,
        yes: true,
        answers: {
          projectName: 'fixture',
          githubRepo: 'owner/fixture',
          trustedAuthor: 'owner',
          installQwen: false,
          linkExtension: true,
          installService: false,
          configureGitHub: false,
        },
      }),
    ).rejects.toThrow('extension link failed');

    expect(existsSync(path.join(root, '.qwen-harness', 'install-receipt.json'))).toBe(true);
    expect(existsSync(path.join(state, 'controller', 'installed', harnessVersion, 'node_modules', 'qwen-dev-bot', 'bin', 'qwen-harness-launcher.mjs'))).toBe(true);
    expect(await uninstallProject(root)).toContain('unregistered project');
  });

  it.skipIf(process.platform === 'win32')('refuses managed-path symlinks before writing template files', async () => {
    const root = makeTmp('installer-symlink-root');
    const outside = makeTmp('installer-symlink-outside');
    process.env.QWEN_HARNESS_STATE_DIR = makeTmp('installer-symlink-state');
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
    symlinkSync(outside, path.join(root, '.qwen'), 'dir');

    await expect(
      installProject({
        root,
        yes: true,
        answers: {
          githubRepo: 'owner/fixture',
          trustedAuthor: 'owner',
          linkExtension: false,
          installService: false,
        },
      }),
    ).rejects.toThrow('Refusing to follow a symlink');
    expect(existsSync(path.join(root, 'AUTONOMY.md'))).toBe(false);
    expect(existsSync(path.join(outside, 'settings.json'))).toBe(false);
  });

  it('rejects traversal injected into an install receipt', async () => {
    const root = makeTmp('installer-receipt-traversal');
    process.env.QWEN_HARNESS_STATE_DIR = makeTmp('installer-receipt-traversal-state');
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
    await installProject({
      root,
      yes: true,
      answers: {
        githubRepo: 'owner/fixture',
        trustedAuthor: 'owner',
        linkExtension: false,
        installService: false,
      },
    });
    const receiptFile = path.join(root, '.qwen-harness', 'install-receipt.json');
    const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
    receipt.files.push({ path: '../outside.txt', sha256: 'bad', owned: true });
    writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);

    await expect(uninstallProject(root)).rejects.toThrow('unsafe path');
  });
});
