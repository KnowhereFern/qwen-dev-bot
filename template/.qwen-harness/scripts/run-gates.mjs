import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const worktree = realpathSync(process.cwd());
const secretValues = Object.entries(process.env)
  .filter(([key, value]) => /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i.test(key) && value && value.length >= 4)
  .map(([, value]) => value);
const receiptPath = path.join(worktree, '.qwen-harness', 'state', 'gate-receipt.json');
const receipt = {
  version: 1,
  runId: randomUUID(),
  startedAt: new Date().toISOString(),
  finishedAt: null,
  worktree,
  cwd: worktree,
  status: 'pending',
  head: null,
  configHash: null,
  contentHash: null,
  finalContentHash: null,
  gates: [],
};

try {
  // Replace any old success before reading config, inspecting Git, or spawning a gate.
  saveReceipt();
  const configBytes = readFileSync('.qwen-harness/project.yml');
  receipt.configHash = hash(configBytes);
  const config = JSON.parse(configBytes.toString('utf8'));
  if (!Array.isArray(config.gates) || config.gates.some(gate => !gate ||
    typeof gate.id !== 'string' || typeof gate.command !== 'string' || !gate.command ||
    !Array.isArray(gate.args) || !gate.args.every(arg => typeof arg === 'string') ||
    typeof gate.required !== 'boolean' || !Number.isSafeInteger(gate.timeoutMs) || gate.timeoutMs <= 0 ||
    (gate.cwd !== undefined && typeof gate.cwd !== 'string'))) throw new Error('INVALID_CONFIG');
  receipt.gates = config.gates.map(gate => ({
    id: redact(gate.id),
    command: redact(gate.command),
    args: gate.args.map((arg, index) => index > 0 && /^--?(?:password|passwd|token|api[-_]key|secret|credential)$/i.test(gate.args[index - 1]) ? '[REDACTED]' : redact(arg)),
    argvHash: hash(JSON.stringify([gate.command, ...gate.args])),
    cwd: redact(path.resolve(worktree, gate.cwd || '.')),
    required: gate.required,
    applicable: !(!gate.required && gate.notApplicableReason),
    notApplicableReason: !gate.required && gate.notApplicableReason ? redact(gate.notApplicableReason) : null,
    timeoutMs: gate.timeoutMs,
    status: 'pending',
    exitCode: null,
    signal: null,
    timedOut: false,
    errorCode: null,
  }));
  receipt.gates.forEach((gate, index) => {
    const configured = config.gates[index];
    gate.argvRedacted = gate.command !== configured.command || gate.args.some((arg, offset) => arg !== configured.args[offset]);
  });
  receipt.head = git(['rev-parse', '--verify', 'HEAD']).toString('utf8').trim();
  receipt.contentHash = contentHash();
  saveReceipt();
  for (const [index, gate] of receipt.gates.entries()) {
    const configured = config.gates[index];
    if (!gate.applicable) {
      console.log(`N/A  ${gate.id}: ${gate.notApplicableReason}`);
      gate.status = 'not_applicable';
      saveReceipt();
      continue;
    }
    console.log(`RUN  ${gate.id}: ${gate.command} ${gate.args.join(' ')}`);
    gate.startedAt = new Date().toISOString();
    Object.assign(gate, await run(configured.command, configured.args, path.resolve(worktree, configured.cwd || '.'), gate.timeoutMs));
    gate.finishedAt = new Date().toISOString();
    gate.status = gate.exitCode === 0 && !gate.signal && !gate.timedOut && !gate.errorCode ? 'passed' : 'failed';
    saveReceipt();
    if (gate.status === 'failed') {
      console.error(`FAIL ${gate.id}: exit ${gate.exitCode ?? 1}`);
      process.exitCode = gate.timedOut ? 124 : gate.exitCode || 1;
      break;
    }
    console.log(`PASS ${gate.id}`);
  }
  receipt.finalContentHash = contentHash();
  const unchanged = receipt.head === git(['rev-parse', '--verify', 'HEAD']).toString('utf8').trim() &&
    receipt.configHash === hash(readFileSync('.qwen-harness/project.yml')) && receipt.contentHash === receipt.finalContentHash;
  receipt.status = !process.exitCode && unchanged ? 'passed' : 'failed';
  if (!unchanged) {
    receipt.errorCode = 'INPUTS_CHANGED';
    process.exitCode ||= 1;
  }
  receipt.finishedAt = new Date().toISOString();
  saveReceipt();
} catch {
  // Never persist exception messages: they can contain paths, command output, or secrets.
  receipt.status = 'failed';
  receipt.errorCode = 'RECEIPT_OR_RUNNER_ERROR';
  receipt.finishedAt = new Date().toISOString();
  try { saveReceipt(); } catch { /* An unsafe receipt path must never be followed. */ }
  console.error('FAIL gate runner: could not safely complete execution evidence');
  process.exitCode = 1;
}

function run(command, args, cwd, timeoutMs) {
  return new Promise(resolve => {
    let timedOut = false;
    let errorCode = null;
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      env: { ...process.env, CI: 'true' }
    });
    const timer = setTimeout(() => {
      timedOut = true;
      terminateTree(child, false);
    }, timeoutMs);
    const forceTimer = setTimeout(() => terminateTree(child, true), timeoutMs + 2_000);
    child.once('error', error => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      errorCode = typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'SPAWN_ERROR';
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      resolve({ exitCode: code, signal, timedOut, errorCode });
    });
  });
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function redact(value) {
  let text = String(value);
  for (const secret of secretValues) text = text.split(secret).join('[REDACTED]');
  return text
    .replace(/((?:password|passwd|token|api[-_]key|secret|credential)\s*[=:]\s*)([^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,})\b/g, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@');
}

function git(args) {
  const result = spawnSync('git', args, { cwd: worktree, shell: false, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('GIT_EVIDENCE_UNAVAILABLE');
  return result.stdout;
}

function contentHash() {
  const names = [...new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).toString('utf8').split('\0').filter(Boolean))].sort();
  const digest = createHash('sha256');
  for (const name of names) {
    // Runtime evidence is not candidate source and must not hash itself.
    if (name.startsWith('.qwen-harness/state/')) continue;
    const file = path.resolve(worktree, name);
    if (!file.startsWith(worktree + path.sep)) throw new Error('UNSAFE_GIT_PATH');
    assertParents(file, false);
    let stat;
    try { stat = lstatSync(file); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      digest.update(JSON.stringify([name, 'missing']));
      continue;
    }
    if (stat.isSymbolicLink()) {
      digest.update(JSON.stringify([name, 'symlink', readlinkSync(file)]));
    } else if (stat.isFile()) {
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error('SOURCE_CHANGED');
        digest.update(JSON.stringify([name, opened.mode & 0o777, hash(readFileSync(fd))]));
      } finally { closeSync(fd); }
    } else {
      // Do not attest a submodule or special file whose contents were not inspected.
      throw new Error('UNSUPPORTED_SOURCE_ENTRY');
    }
  }
  return digest.digest('hex');
}

function assertParents(file, create) {
  const relative = path.relative(worktree, path.dirname(file));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('UNSAFE_RECEIPT_PATH');
  let current = worktree;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (create) {
      try { mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    let stat;
    try { stat = lstatSync(current); } catch (error) {
      if (!create && error.code === 'ENOENT') return;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('UNSAFE_RECEIPT_PATH');
  }
}

function saveReceipt() {
  assertParents(receiptPath, true);
  try {
    const stat = lstatSync(receiptPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('UNSAFE_RECEIPT_PATH');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(path.dirname(receiptPath), `.gate-receipt-${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, JSON.stringify(receipt, null, 2) + '\n');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    assertParents(receiptPath, false);
    try {
      if (lstatSync(receiptPath).isSymbolicLink()) throw new Error('UNSAFE_RECEIPT_PATH');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    renameSync(temporary, receiptPath);
  } finally {
    // Delete only the private temporary file created by this invocation.
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
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
