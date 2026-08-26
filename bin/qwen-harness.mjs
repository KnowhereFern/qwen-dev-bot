#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const tsxLoader = import.meta.resolve('tsx');
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', tsxLoader, entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
  windowsHide: true,
});

const forwardedSignals = new Map();
for (const signal of ['SIGINT', 'SIGTERM']) {
  const forward = () => child.kill(signal);
  forwardedSignals.set(signal, forward);
  process.on(signal, forward);
}

child.once('error', (error) => {
  console.error(`qwen-harness failed to start: ${error.message}`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  for (const [name, listener] of forwardedSignals) process.removeListener(name, listener);
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
