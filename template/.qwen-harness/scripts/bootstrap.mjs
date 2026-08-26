import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const checkOnly = process.argv.includes('--check');
const commands = [];
if (existsSync('package-lock.json')) commands.push(['npm', checkOnly ? ['ls', '--depth=0'] : ['ci']]);
else if (existsSync('pnpm-lock.yaml')) commands.push(['corepack', ['pnpm', checkOnly ? 'list' : 'install', ...(checkOnly ? ['--depth=0'] : ['--frozen-lockfile'])]]);
else if (existsSync('yarn.lock')) commands.push(['corepack', ['yarn', 'install', '--immutable', ...(checkOnly ? ['--mode=skip-builds'] : [])]]);
else if (existsSync('bun.lock') || existsSync('bun.lockb')) commands.push(['bun', [checkOnly ? 'pm' : 'install', ...(checkOnly ? ['ls'] : ['--frozen-lockfile'])]]);
else if (existsSync('package.json') && declaredNodePackages().size > 0) {
  throw new Error('Node dependencies are declared but no supported lockfile is committed.');
}

if (existsSync('uv.lock')) commands.push(['uv', ['sync', ...(checkOnly ? ['--check'] : ['--frozen'])]]);
else if (existsSync('requirements.txt')) {
  const systemPython = process.platform === 'win32' ? 'python' : 'python3';
  const venvPython = path.join('.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!existsSync(venvPython)) {
    if (checkOnly) throw new Error('requirements.txt exists but the project-local .venv is missing.');
    commands.push([systemPython, ['-m', 'venv', '.venv']]);
  }
  commands.push([venvPython, ['-m', 'pip', checkOnly ? 'check' : 'install', ...(!checkOnly ? ['-r', 'requirements.txt'] : [])]]);
}

for (const [command, args] of commands) {
  const code = await run(command, args, 10 * 60_000);
  if (code !== 0) process.exit(code);
}

const packages = declaredNodePackages();
if (packages.has('@playwright/test') || packages.has('playwright')) {
  const playwright = path.join('node_modules', '.bin', process.platform === 'win32' ? 'playwright.cmd' : 'playwright');
  if (!existsSync(playwright)) throw new Error('Playwright is declared but its local CLI is missing.');
  const code = await run(playwright, checkOnly ? ['install', '--list'] : ['install'], 15 * 60_000);
  if (code !== 0) process.exit(code);
}
if (packages.has('cypress')) {
  const cypress = path.join('node_modules', '.bin', process.platform === 'win32' ? 'cypress.cmd' : 'cypress');
  if (!existsSync(cypress)) throw new Error('Cypress is declared but its local CLI is missing.');
  const code = await run(cypress, ['verify'], 5 * 60_000);
  if (code !== 0) process.exit(code);
}

console.log(checkOnly ? 'Dependency check passed.' : 'Project dependencies and declared browser runtimes are installed.');

function declaredNodePackages() {
  if (!existsSync('package.json')) return new Set();
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]);
}

function run(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit', shell: false, detached: process.platform !== 'win32', windowsHide: true
    });
    const timer = setTimeout(() => terminateTree(child, false), timeoutMs);
    const forceTimer = setTimeout(() => terminateTree(child, true), timeoutMs + 2_000);
    child.once('error', error => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      reject(new Error(`Could not run ${command}: ${error.message}`));
    });
    child.once('close', code => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      resolve(code);
    });
  });
}

function terminateTree(child, force) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill.exe', ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])], {
      stdio: 'ignore', shell: false, windowsHide: true
    }).unref();
    return;
  }
  try {
    process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
  }
}
