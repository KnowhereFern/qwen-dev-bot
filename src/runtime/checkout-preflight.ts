import { existsSync } from 'node:fs';
import path from 'node:path';
import { formatProcessFailure, gateEnvironment, runProcess } from './safe-process.js';

export async function prepareProjectCheckout(checkout: string, signal?: AbortSignal): Promise<void> {
  const bootstrap = path.join(checkout, '.qwen-harness', 'scripts', 'bootstrap.mjs');
  if (!existsSync(bootstrap)) return;
  const result = await runProcess({
    command: process.execPath,
    args: [bootstrap],
    cwd: checkout,
    timeoutMs: 30 * 60_000,
    signal,
    env: gateEnvironment({ ...process.env, CI: 'true', NODE_ENV: 'test' }),
    maxOutputBytes: 10 * 1024 * 1024,
  });
  if (result.exitCode !== 0 || result.timedOut || result.aborted) {
    throw new Error(`Checkout dependency preparation failed: ${formatProcessFailure(result, 4_000)}`);
  }
}
