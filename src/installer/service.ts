import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { harnessStateRoot } from '../core/state-paths.js';
import { runProcess } from '../runtime/safe-process.js';

const LAUNCHD_LABEL = 'dev.qwen-harness.worker';
const LEGACY_LAUNCHD_LABEL = 'com.fern.qwen-harness';

export interface ServiceReceipt {
  platform: NodeJS.Platform;
  file: string;
  envFile: string;
  credentialsPersisted: boolean;
  installed: boolean;
  message: string;
}

export async function installWorkerService(
  binPath: string,
  options: {
    dryRun?: boolean;
    persistCredentials?: boolean;
    credentialEnvKey?: string;
    credentialValue?: string;
  } = {},
): Promise<ServiceReceipt> {
  const dryRun = Boolean(options.dryRun);
  const stateRoot = harnessStateRoot();
  const envFile = path.join(stateRoot, 'worker.env');
  const credentialEnvKey = options.credentialEnvKey ?? 'DASHSCOPE_API_KEY';
  const credentials: Record<string, string | undefined> = {
    DASHSCOPE_API_KEY: readWorkerEnvironmentValue(envFile, 'DASHSCOPE_API_KEY'),
    BAILIAN_CODING_PLAN_API_KEY: readWorkerEnvironmentValue(envFile, 'BAILIAN_CODING_PLAN_API_KEY'),
    BAILIAN_TOKEN_PLAN_API_KEY: readWorkerEnvironmentValue(envFile, 'BAILIAN_TOKEN_PLAN_API_KEY'),
    BAILIAN_API_KEY: readWorkerEnvironmentValue(envFile, 'BAILIAN_API_KEY'),
  };
  const existingBaseUrl = readWorkerEnvironmentValue(envFile, 'DASHSCOPE_BASE_URL');
  if (options.persistCredentials) credentials[credentialEnvKey] = options.credentialValue;
  const workerKey = credentials[credentialEnvKey];
  const workerBaseUrl = options.persistCredentials ? process.env.DASHSCOPE_BASE_URL : existingBaseUrl;
  const credentialsPersisted = Boolean(workerKey);
  if (!dryRun) {
    mkdirSync(path.join(stateRoot, 'logs'), { recursive: true, mode: 0o700 });
    writeWorkerEnvironment(envFile, stateRoot, credentials, workerBaseUrl);
  }
  const launcherPath = path.join(path.dirname(binPath), 'qwen-harness-launcher.mjs');
  const programArguments = [process.execPath, `--env-file-if-exists=${envFile}`, existsSync(launcherPath) ? launcherPath : binPath, 'worker'];
  if (process.platform === 'darwin') {
    const file = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
    const legacyFile = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LEGACY_LAUNCHD_LABEL}.plist`);
    const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key><array>
    ${programArguments.map((argument) => `<string>${xml(argument)}</string>`).join('')}
  </array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(path.join(stateRoot, 'logs', 'worker.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(stateRoot, 'logs', 'worker.error.log'))}</string>
</dict></plist>
`;
    if (!dryRun) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, contents, { mode: 0o600 });
      chmodSync(file, 0o600);
      await runProcess({ command: 'launchctl', args: ['bootout', `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`], cwd: os.homedir(), timeoutMs: 10_000 });
      await runProcess({ command: 'launchctl', args: ['bootout', `gui/${process.getuid?.() ?? 0}/${LEGACY_LAUNCHD_LABEL}`], cwd: os.homedir(), timeoutMs: 10_000 });
      if (existsSync(legacyFile)) rmSync(legacyFile);
      const loaded = await runProcess({ command: 'launchctl', args: ['bootstrap', `gui/${process.getuid?.() ?? 0}`, file], cwd: os.homedir(), timeoutMs: 10_000 });
      if (loaded.exitCode !== 0) return { platform: process.platform, file, envFile, credentialsPersisted, installed: false, message: loaded.stderr.trim() };
    }
    return { platform: process.platform, file, envFile, credentialsPersisted, installed: !dryRun, message: dryRun ? 'would install launchd service' : 'launchd service installed' };
  }

  if (process.platform === 'linux') {
    const file = path.join(os.homedir(), '.config', 'systemd', 'user', 'qwen-harness.service');
    const contents = `[Unit]
Description=Qwen autonomous development harness
After=network-online.target

[Service]
Type=simple
ExecStart=${programArguments.map(systemdQuote).join(' ')}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
    if (!dryRun) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, contents, { mode: 0o600 });
      await runProcess({ command: 'systemctl', args: ['--user', 'daemon-reload'], cwd: os.homedir(), timeoutMs: 10_000 });
      const enabled = await runProcess({ command: 'systemctl', args: ['--user', 'enable', '--now', 'qwen-harness.service'], cwd: os.homedir(), timeoutMs: 20_000 });
      if (enabled.exitCode !== 0) return { platform: process.platform, file, envFile, credentialsPersisted, installed: false, message: enabled.stderr.trim() };
    }
    return { platform: process.platform, file, envFile, credentialsPersisted, installed: !dryRun, message: dryRun ? 'would install systemd user service' : 'systemd user service installed' };
  }

  if (process.platform === 'win32') {
    const file = path.join(stateRoot, 'qwen-harness-worker.cmd');
    const commandLine = programArguments.map(windowsQuote).join(' ');
    if (!dryRun) {
      writeFileSync(file, `@echo off\r\n${commandLine}\r\n`, { mode: 0o600 });
      const created = await runProcess({
        command: 'schtasks.exe',
        args: ['/Create', '/F', '/SC', 'ONLOGON', '/TN', 'QwenHarness', '/TR', commandLine],
        cwd: stateRoot,
        timeoutMs: 20_000,
      });
      if (created.exitCode !== 0) return { platform: process.platform, file, envFile, credentialsPersisted, installed: false, message: created.stderr.trim() };
    }
    return { platform: process.platform, file, envFile, credentialsPersisted, installed: !dryRun, message: dryRun ? 'would install Windows scheduled task' : 'Windows scheduled task installed' };
  }

  return { platform: process.platform, file: '', envFile, credentialsPersisted, installed: false, message: 'automatic service installation is unsupported on this platform' };
}

export async function uninstallWorkerService(): Promise<void> {
  if (process.platform === 'darwin') {
    const file = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
    const legacyFile = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LEGACY_LAUNCHD_LABEL}.plist`);
    await runProcess({ command: 'launchctl', args: ['bootout', `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`], cwd: os.homedir(), timeoutMs: 10_000 });
    await runProcess({ command: 'launchctl', args: ['bootout', `gui/${process.getuid?.() ?? 0}/${LEGACY_LAUNCHD_LABEL}`], cwd: os.homedir(), timeoutMs: 10_000 });
    if (existsSync(file)) rmSync(file);
    if (existsSync(legacyFile)) rmSync(legacyFile);
  } else if (process.platform === 'linux') {
    await runProcess({ command: 'systemctl', args: ['--user', 'disable', '--now', 'qwen-harness.service'], cwd: os.homedir(), timeoutMs: 20_000 });
    const file = path.join(os.homedir(), '.config', 'systemd', 'user', 'qwen-harness.service');
    if (existsSync(file)) rmSync(file);
  } else if (process.platform === 'win32') {
    await runProcess({ command: 'schtasks.exe', args: ['/Delete', '/F', '/TN', 'QwenHarness'], cwd: os.homedir(), timeoutMs: 20_000 });
  }
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function windowsQuote(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function writeWorkerEnvironment(
  file: string,
  stateRoot: string,
  credentials: Record<string, string | undefined>,
  baseUrl: string | undefined,
): void {
  const values: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    QWEN_HARNESS_STATE_DIR: stateRoot,
    ...credentials,
    DASHSCOPE_BASE_URL: baseUrl,
  };
  const lines = Object.entries(values)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`);
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function readWorkerEnvironmentValue(file: string, name: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .find((candidate) => candidate.startsWith(`${name}=`));
  if (!line) return undefined;
  const raw = line.slice(name.length + 1);
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === 'string' ? value : undefined;
  } catch {
    return raw || undefined;
  }
}
