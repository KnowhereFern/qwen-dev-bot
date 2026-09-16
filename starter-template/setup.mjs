import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const minimumNode = [22, 5];
const currentNode = process.versions.node.split('.').map(Number);
if (currentNode[0] < minimumNode[0] || (currentNode[0] === minimumNode[0] && currentNode[1] < minimumNode[1])) {
  fail(`Node 22.5+ is required; found ${process.versions.node}`);
}

const git = spawnSync('git', ['--version'], { encoding: 'utf8', shell: false });
if (git.status !== 0) fail('Git is required. Install Git, then rerun node setup.mjs.');

const ref = 'v1.0.0-rc.7';
const source = 'https://github.com/KnowhereFern/qwen-dev-bot.git';
const temp = mkdtempSync(path.join(os.tmpdir(), 'qwen-dev-bot-'));

try {
  run('git', ['init', '--quiet'], temp, 30_000);
  run('git', ['remote', 'add', 'origin', source], temp, 30_000);
  run('git', ['fetch', '--quiet', '--depth', '1', 'origin', `refs/tags/${ref}`], temp, 5 * 60_000);
  run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD^{}'], temp, 30_000);
  run(npm(), ['ci'], temp, 10 * 60_000);
  run(process.execPath, [path.join(temp, 'bin', 'qwen-harness.mjs'), 'init', process.cwd(), ...process.argv.slice(2)], process.cwd(), 30 * 60_000);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

function npm() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function run(command, args, cwd, timeout) {
  const receipt = spawnSync(command, args, { cwd, shell: false, stdio: 'inherit', timeout });
  if (receipt.error) fail(receipt.error.message);
  if (receipt.status !== 0) fail(`${command} exited with ${receipt.status ?? 'no status'}`);
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}
