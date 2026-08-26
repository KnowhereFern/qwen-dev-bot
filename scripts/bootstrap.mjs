import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

if (!nodeAtLeast(22, 5)) {
  fail(`Node 22.5+ is required; found ${process.versions.node}.`);
}
if (!existsSync(path.resolve('package-lock.json'))) fail('package-lock.json is required for a reproducible harness install.');

await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci'], process.cwd(), 10 * 60_000);

const supplied = process.argv.slice(2);
let target = supplied.find((argument) => !argument.startsWith('-'));
if (!target) {
  if (!process.stdin.isTTY) fail('Pass the target project path: npm run bootstrap -- /absolute/path/to/project');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    target = (await terminal.question('Project folder to equip with the Qwen harness: ')).trim();
  } finally {
    terminal.close();
  }
}
if (!target) fail('A target project folder is required.');
const targetRoot = path.resolve(target);
if (!existsSync(targetRoot)) fail(`Target project does not exist: ${targetRoot}`);

const forwarded = supplied.filter((argument) => argument !== target);
await run(process.execPath, [path.resolve('bin/qwen-harness.mjs'), 'init', targetRoot, ...forwarded], process.cwd(), 30 * 60_000);
if (supplied.includes('--dry-run')) {
  console.log(`\nDry run complete. Run the same command without --dry-run when ready.`);
} else {
  console.log(`\nSetup complete. Review and commit the generated files, then run:\n  npm run preflight -- ${JSON.stringify(targetRoot)}`);
}

function nodeAtLeast(major, minor) {
  const [currentMajor, currentMinor] = process.versions.node.split('.').map(Number);
  return currentMajor > major || (currentMajor === major && currentMinor >= minor);
}

function run(command, args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: false, windowsHide: true });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? 'no status'}`));
    });
  });
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}
