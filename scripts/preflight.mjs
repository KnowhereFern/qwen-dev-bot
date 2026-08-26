import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const checks = [];
checks.push(['node', nodeAtLeast(22, 5), `Node ${process.versions.node} (22.5+ required)`]);
checks.push(['lockfile', existsSync(path.resolve('package-lock.json')), 'Harness package-lock.json present']);
checks.push(['dependencies', await succeeds(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ls', '--depth=0']), 'Harness npm dependency tree valid']);
checks.push(['git', await succeeds('git', ['--version']), 'Git available']);
checks.push(['github-cli', await succeeds('gh', ['--version']), 'GitHub CLI available']);
const qwen = await outputOf('qwen', ['--version']);
checks.push(['qwen-code', qwen.ok && versionAtLeast(qwen.output, '0.22.1'), `Qwen Code ${qwen.output || 'not found'} (0.22.1+ required)`]);

for (const [id, ok, summary] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(18)} ${summary}`);
if (checks.some(([, ok]) => !ok)) process.exitCode = 1;

const target = process.argv[2];
if (target) {
  const root = path.resolve(target);
  const config = path.join(root, '.qwen-harness', 'project.yml');
  if (!existsSync(config)) {
    console.error(`FAIL  target             Missing ${config}; run npm run bootstrap -- ${JSON.stringify(root)}`);
    process.exitCode = 1;
  } else {
    const doctorCode = await inherit(process.execPath, [path.resolve('bin/qwen-harness.mjs'), 'doctor', root]);
    if (doctorCode !== 0 || process.exitCode) process.exitCode = 1;
  }
}

function nodeAtLeast(major, minor) {
  const [currentMajor, currentMinor] = process.versions.node.split('.').map(Number);
  return currentMajor > major || (currentMajor === major && currentMinor >= minor);
}

function versionAtLeast(value, minimum) {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const current = match.slice(1).map(Number);
  const required = minimum.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (current[index] !== required[index]) return current[index] > required[index];
  }
  return true;
}

async function succeeds(command, args) {
  return (await outputOf(command, args)).ok;
}

function outputOf(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: process.cwd(), shell: false, windowsHide: true });
    let output = '';
    child.stdout?.on('data', (chunk) => { output += String(chunk); });
    child.stderr?.on('data', (chunk) => { output += String(chunk); });
    child.once('error', () => resolve({ ok: false, output: '' }));
    child.once('close', (code) => resolve({ ok: code === 0, output: output.trim().split('\n')[0] ?? '' }));
  });
}

function inherit(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: process.cwd(), stdio: 'inherit', shell: false, windowsHide: true });
    child.once('error', () => resolve(1));
    child.once('close', (code) => resolve(code ?? 1));
  });
}
