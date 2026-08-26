import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const temp = mkdtempSync(path.join(os.tmpdir(), 'qwen-harness-package-'));
const packageDir = path.join(temp, 'package');
mkdirSync(packageDir);

try {
  run(npm(), ['pack', '--pack-destination', temp], root);
  const archive = readdirSync(temp).find((name) => name.endsWith('.tgz'));
  if (!archive) throw new Error('npm pack did not create an archive');
  writeFileSync(path.join(packageDir, 'package.json'), `${JSON.stringify({ private: true, dependencies: { 'qwen-dev-bot': `file:${path.join(temp, archive)}` } }, null, 2)}\n`);
  run(npm(), ['install', '--ignore-scripts', '--no-audit', '--no-fund'], packageDir);
  const command = process.platform === 'win32'
    ? path.join(packageDir, 'node_modules', '.bin', 'qwen-harness.cmd')
    : path.join(packageDir, 'node_modules', '.bin', 'qwen-harness');
  const receipt = spawnSync(command, ['--version'], { cwd: packageDir, encoding: 'utf8', shell: false });
  if (receipt.status !== 0) throw new Error(receipt.stderr || 'packaged qwen-harness failed to start');
  if (receipt.stdout.trim() !== version) throw new Error(`packaged CLI returned ${receipt.stdout.trim()}, expected ${version}`);
  console.log(`PASS  packed CLI installs and reports ${version}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

function npm() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function run(command, args, cwd) {
  const receipt = spawnSync(command, args, { cwd, encoding: 'utf8', shell: false, stdio: 'inherit' });
  if (receipt.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with ${receipt.status ?? 'no status'}`);
}
