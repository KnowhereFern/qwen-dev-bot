#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fallbackBin = fileURLToPath(new URL('./qwen-harness.mjs', import.meta.url));
const stateRoot = process.env.QWEN_HARNESS_STATE_DIR ?? (
  process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'qwen-harness')
    : process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'qwen-harness')
      : path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'qwen-harness')
);
const manifestFile = path.join(stateRoot, 'controller', 'active-release.json');

launch(resolveTarget(), false);

function launch(target, recovery) {
  const child = spawn(process.execPath, [target.bin, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
    windowsHide: true,
  });
  const forwarded = new Map();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const listener = () => child.kill(signal);
    forwarded.set(signal, listener);
    process.on(signal, listener);
  }
  child.once('error', (error) => {
    console.error(`qwen-harness launcher failed: ${error.message}`);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    for (const [name, listener] of forwarded) process.removeListener(name, listener);
    if (!recovery && code !== 0 && target.manifest && Date.now() < target.manifest.probationEndsAt) {
      const baselineBin = path.join(target.manifest.baselineRoot, 'bin', 'qwen-harness.mjs');
      if (existsSync(baselineBin)) {
        restoreBaseline(target.manifest);
        launch({ bin: baselineBin, manifest: null }, true);
        return;
      }
    }
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

function resolveTarget() {
  if (!existsSync(manifestFile)) return { bin: fallbackBin, manifest: null };
  try {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    const { checksum, ...unsigned } = manifest;
    if (checksum !== sha256(JSON.stringify(unsigned))) throw new Error('checksum mismatch');
    const bin = path.join(manifest.activeRoot, 'bin', 'qwen-harness.mjs');
    if (!path.isAbsolute(manifest.activeRoot) || !existsSync(bin)) throw new Error('invalid release root');
    return { bin, manifest };
  } catch (error) {
    console.error(`Ignoring invalid controller release manifest: ${error instanceof Error ? error.message : String(error)}`);
    return { bin: fallbackBin, manifest: null };
  }
}

function restoreBaseline(manifest) {
  const unsigned = {
    version: 1,
    releaseId: manifest.baselineReleaseId ?? 'installed-baseline',
    activeRoot: manifest.baselineRoot,
    baselineReleaseId: null,
    baselineRoot: manifest.baselineRoot,
    commitSha: 'rollback',
    probationEndsAt: 0,
    writtenAt: Date.now(),
  };
  const temporary = `${manifestFile}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...unsigned, checksum: sha256(JSON.stringify(unsigned)) }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, manifestFile);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
