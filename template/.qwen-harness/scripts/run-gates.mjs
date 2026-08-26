import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const config = JSON.parse(readFileSync('.qwen-harness/project.yml', 'utf8'));
for (const gate of config.gates) {
  if (!gate.required && gate.notApplicableReason) {
    console.log(`N/A  ${gate.id}: ${gate.notApplicableReason}`);
    continue;
  }
  console.log(`RUN  ${gate.id}: ${gate.command} ${gate.args.join(' ')}`);
  const code = await run(gate.command, gate.args, gate.cwd || process.cwd(), gate.timeoutMs);
  if (code !== 0) {
    console.error(`FAIL ${gate.id}: exit ${code}`);
    process.exit(code || 1);
  }
  console.log(`PASS ${gate.id}`);
}

function run(command, args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      env: { ...process.env, CI: 'true' }
    });
    const timer = setTimeout(() => terminateTree(child, false), timeoutMs);
    const forceTimer = setTimeout(() => terminateTree(child, true), timeoutMs + 2_000);
    child.once('error', error => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      resolve(code ?? 1);
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
