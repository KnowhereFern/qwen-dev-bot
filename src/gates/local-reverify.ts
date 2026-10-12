import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, rmSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GateDefinition } from '../core/types.js';
import { redactText } from '../core/ledger.js';
import { gateEnvironment, runProcess } from '../runtime/safe-process.js';

export interface LocalGateReverification {
  runId: string;
  head: string;
  gateCount: number;
}

/** Tolerated clock skew (ms) for receipt timestamp and mtime freshness bounds. */
export const RECEIPT_CLOCK_SKEW_MS = 5_000;

export interface LocalGateReverificationOptions {
  worktreePath: string;
  expectedHead: string;
  gates: GateDefinition[];
  signal?: AbortSignal;
}

/**
 * Absolute path of the immutable controller-packaged gate runner, resolved
 * from the installed package template directory. Returns null whenever the
 * asset is missing or not a regular file so callers fail closed instead of
 * ever executing a mutable tracked project copy of the runner.
 */
export function immutableGateRunnerPath(): string | null {
  try {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const runnerPath = path.join(packageRoot, 'template', '.qwen-harness', 'scripts', 'run-gates.mjs');
    const stat = lstatSync(runnerPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    return runnerPath;
  } catch {
    return null;
  }
}

/**
 * Deterministic local gate re-verification of an uncommitted Qwen candidate.
 *
 * Runs the immutable controller-packaged
 * `template/.qwen-harness/scripts/run-gates.mjs` with the candidate worktree
 * as cwd — never a tracked or otherwise mutable project copy of the runner —
 * and requires:
 *
 * - a terminal exit code of 0 (no timeout, no abort);
 * - a fresh machine receipt written by this very invocation (not a stale
 *   previously-passed receipt left behind by an earlier run);
 * - receipt status `passed` with the exact candidate worktree path and the
 *   exact HEAD at gate time (which may be a prior repair candidate);
 * - identical pre/post content hashes, so the inputs the gates evaluated are
 *   byte-for-byte the final candidate (no edits landed during execution);
 * - every configured gate present in the receipt, with each required gate
 *   applicable and passed.
 *
 * The gate configuration is materialized from the controller-owned config
 * (never from implementer-controlled tracked bytes), and every file this
 * function creates is removed before returning, so the candidate worktree is
 * left exactly as the Qwen handoff produced it; restoration and removal are
 * verified (bytes or absence) and a failed cleanup fails closed rather than
 * silently leaving artifacts. Any missing runner, invalid
 * receipt, or failed check throws — callers must fail closed.
 */
export async function runLocalGateReverification(options: LocalGateReverificationOptions): Promise<LocalGateReverification> {
  if (typeof constants.O_NOFOLLOW !== 'number') {
    throw new Error('Local gate re-verification failed: this platform cannot safely open the gate config without following symlinks');
  }
  const worktree = realpathSync(options.worktreePath);
  const runnerPath = immutableGateRunnerPath();
  if (runnerPath === null) {
    throw new Error(
      'Local gate re-verification failed: immutable controller runner template/.qwen-harness/scripts/run-gates.mjs is missing or not a regular file',
    );
  }

  const harnessDir = path.join(worktree, '.qwen-harness');
  const configPath = path.join(harnessDir, 'project.yml');
  const stateDir = path.join(harnessDir, 'state');
  const receiptPath = path.join(stateDir, 'gate-receipt.json');

  // Fail closed before any write or remove: every path segment this helper
  // touches must be a real directory or regular file, never a symlink or
  // other special file, so cleanup can never follow links out of the
  // candidate worktree.
  const harnessStat = safeLstat(harnessDir);
  if (harnessStat !== null && (harnessStat.isSymbolicLink() || !harnessStat.isDirectory())) {
    throw new Error('Local gate re-verification failed: .qwen-harness in the candidate worktree is not a real directory');
  }
  const stateStat = safeLstat(stateDir);
  if (stateStat !== null && (stateStat.isSymbolicLink() || !stateStat.isDirectory())) {
    throw new Error('Local gate re-verification failed: .qwen-harness/state in the candidate worktree is not a real directory');
  }
  const configStat = safeLstat(configPath);
  if (configStat !== null && (configStat.isSymbolicLink() || !configStat.isFile())) {
    throw new Error('Local gate re-verification failed: .qwen-harness/project.yml in the candidate worktree is a symlink or not a regular file');
  }
  const priorConfig = configStat !== null && configStat.isFile() ? readFileSync(configPath) : null;
  const priorConfigMode = configStat !== null && configStat.isFile() ? configStat.mode & 0o777 : null;

  let primaryError: unknown;
  try {
    mkdirSync(harnessDir, { recursive: true });
    // The authoritative gate set comes from the controller config. A tracked
    // project.yml edited by the implementer during the session is never
    // trusted to define (or drop) required gates. The write is race-safe:
    // O_NOFOLLOW makes the open fail (ELOOP) instead of ever following a
    // symlink swapped in after the pre-check lstat. The temporary config is
    // created 0o600 (owner-only): only this controller and the gate runner
    // subprocess it spawns — both running as the same user — ever need to
    // read it, and the file is removed again in cleanup.
    const configBytes = Buffer.from(`${JSON.stringify({ gates: options.gates }, null, 2)}\n`, 'utf8');
    writeConfigNoFollow(configPath, configBytes, 0o600);
    const expectedConfigHash = sha256Hex(configBytes);
    const preContentHash = controllerContentHash(worktree);

    const startedMs = Date.now();
    const timeoutMs = Math.max(30_000, options.gates.reduce((total, gate) => total + gate.timeoutMs, 0) + 60_000);
    const result = await runProcess({
      command: process.execPath,
      args: [runnerPath],
      cwd: worktree,
      timeoutMs,
      signal: options.signal,
      env: gateEnvironment({ ...process.env, CI: 'true', NODE_ENV: 'test' }),
    });
    if (result.exitCode !== 0 || result.timedOut || result.aborted) {
      throw new Error(
        `Local gate re-verification failed: immutable gate runner ${
          result.timedOut ? 'timed out' : result.aborted ? 'was aborted' : `exited ${String(result.exitCode)}`
        }: ${redactText((result.stderr.trim() || result.stdout.trim()).slice(-1_200))}`,
      );
    }
    const postContentHash = controllerContentHash(worktree);

    const receiptStat = safeLstat(receiptPath);
    if (receiptStat === null || receiptStat.isSymbolicLink() || !receiptStat.isFile()) {
      throw new Error('Local gate re-verification failed: no regular machine gate receipt was written in the candidate worktree');
    }
    // The receipt file itself must have been freshly written by this very
    // invocation: an old mtime means a stale receipt survived (a previously
    // passed run that predates later edits), and a future mtime means
    // tampering or a badly skewed clock.
    const nowMs = Date.now();
    if (receiptStat.mtimeMs < startedMs - RECEIPT_CLOCK_SKEW_MS || receiptStat.mtimeMs > nowMs + RECEIPT_CLOCK_SKEW_MS) {
      throw new Error('Local gate re-verification failed: the machine gate receipt file was not freshly written by this re-verification run');
    }
    let receipt: unknown;
    try {
      receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    } catch {
      throw new Error('Local gate re-verification failed: machine gate receipt is not valid JSON');
    }
    const verified = validateReceipt(receipt, {
      worktree,
      expectedHead: options.expectedHead,
      startedMs,
      nowMs,
      gates: options.gates,
      expectedConfigHash,
      preContentHash,
      postContentHash,
    });
    return { runId: verified.runId, head: verified.head, gateCount: verified.gateCount };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    // Leave the candidate worktree exactly as the Qwen handoff produced it:
    // restore any pre-existing project.yml bytes and drop harness-owned
    // re-verification state (including any stale previously-passed receipt,
    // which must never survive as seemingly-fresh evidence) so no gate
    // artifact can ride into the commit. Cleanup is verified, not
    // best-effort: a restore/removal whose result cannot be confirmed
    // fails closed instead of silently leaving artifacts behind.
    try {
      restoreCandidateWorktree({ configPath, stateDir, receiptPath }, priorConfig, priorConfigMode);
    } catch (cleanupError) {
      if (primaryError === undefined) throw cleanupError;
      // The primary run failure (already propagating) must not be masked by
      // the cleanup failure; preserve it.
    }
  }
}

function restoreCandidateWorktree(
  paths: { configPath: string; stateDir: string; receiptPath: string },
  priorConfig: Buffer | null,
  priorConfigMode: number | null,
): void {
  // Re-verify path types immediately before every write/remove so cleanup
  // cannot follow a symlink or special file swapped in while the gate runner
  // executed.
  const configStat = safeLstat(paths.configPath);
  if (configStat !== null && (configStat.isSymbolicLink() || !configStat.isFile())) {
    throw new Error('Local gate re-verification cleanup failed: .qwen-harness/project.yml is no longer a regular file; refusing to touch it');
  }
  const stateStat = safeLstat(paths.stateDir);
  if (stateStat !== null && (stateStat.isSymbolicLink() || !stateStat.isDirectory())) {
    throw new Error('Local gate re-verification cleanup failed: .qwen-harness/state is no longer a real directory; refusing to touch it');
  }
  const receiptStat = safeLstat(paths.receiptPath);
  if (receiptStat !== null && (receiptStat.isSymbolicLink() || !receiptStat.isFile())) {
    throw new Error('Local gate re-verification cleanup failed: gate receipt is no longer a regular file; refusing to touch it');
  }

  // Attempt both cleanup steps even if one fails, so a config restoration
  // failure cannot leave a stale gate receipt behind, then report all
  // failures together.
  const failures: string[] = [];
  try {
    if (priorConfig === null) {
      rmSync(paths.configPath, { force: true });
      if (safeLstat(paths.configPath) !== null) throw new Error('still present');
    } else {
      writeRestoredConfig(paths.configPath, priorConfig, priorConfigMode ?? 0o644);
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : 'project.yml restoration failed');
  }
  try {
    rmSync(paths.receiptPath, { force: true });
    if (safeLstat(paths.receiptPath) !== null) throw new Error('still present');
  } catch (error) {
    failures.push(
      error instanceof Error && error.message.startsWith('Local gate re-verification cleanup failed:')
        ? error.message
        : 'Local gate re-verification cleanup failed: the gate receipt could not be removed',
    );
  }
  if (failures.length > 0) {
    throw new Error(failures.join('; '));
  }
}

function writeRestoredConfig(configPath: string, priorConfig: Buffer, priorMode: number): void {
  let fd: number | undefined;
  try {
    // Race-safe restore: O_NOFOLLOW makes the open fail (ELOOP) instead of
    // ever writing through a symlink swapped in after the cleanup lstat, and
    // all writes/verification go through this single file descriptor, so a
    // path swap mid-write cannot redirect the bytes outside the worktree.
    fd = openSync(configPath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error('restoration target is not a regular file');
    if ((opened.mode & 0o777) !== priorMode) fchmodSync(fd, priorMode);
    writeAll(fd, priorConfig);
    // Verify through a fresh O_NOFOLLOW read descriptor that is confirmed to
    // still resolve to the exact inode that received the restored bytes
    // (dev + ino equality against the write descriptor), so both the bytes
    // and the original mode are confirmed in place and a path swap cannot
    // fool the verification.
    const verifyFd = openSync(configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const reopened = fstatSync(verifyFd);
      if (!reopened.isFile() || reopened.dev !== opened.dev || reopened.ino !== opened.ino) {
        throw new Error('restoration verification resolved to a different file than the one written');
      }
      const readBack = Buffer.allocUnsafe(priorConfig.length);
      let total = 0;
      while (total < readBack.length) {
        const bytesRead = readSync(verifyFd, readBack, total, readBack.length - total, total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total !== priorConfig.length || !readBack.subarray(0, total).equals(priorConfig)) {
        throw new Error('restored bytes do not match');
      }
      if ((fstatSync(verifyFd).mode & 0o777) !== priorMode) {
        throw new Error('restored file mode does not match');
      }
    } finally {
      closeSync(verifyFd);
    }
    return;
  } catch {
    // fall through to the fail-closed error below
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  throw new Error(
    'Local gate re-verification cleanup failed: pre-existing .qwen-harness/project.yml bytes could not be restored',
  );
}

/**
 * Writes `data` to `configPath` through a single O_NOFOLLOW file descriptor:
 * the open fails closed (ELOOP) if the final path component is or becomes a
 * symlink after the pre-check lstat, so the write can never follow a swapped
 * link outside the candidate worktree. The descriptor is closed even on
 * failure, and any error (including ELOOP) propagates as a fail-closed error.
 */
function writeConfigNoFollow(configPath: string, data: Buffer, mode: number): void {
  let fd: number | undefined;
  try {
    fd = openSync(configPath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, mode);
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error('write target is not a regular file');
    writeAll(fd, data);
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(
        'Local gate re-verification failed: .qwen-harness/project.yml is a symlink or was swapped for one; refusing to write through it',
      );
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeAll(fd: number, data: Buffer): void {
  let written = 0;
  while (written < data.length) {
    written += writeSync(fd, data, written, data.length - written);
  }
}

export function validateReceipt(
  receipt: unknown,
  expected: {
    worktree: string;
    expectedHead: string;
    startedMs: number;
    nowMs: number;
    gates: GateDefinition[];
    expectedConfigHash: string;
    preContentHash: string;
    postContentHash: string;
  },
): { runId: string; head: string; gateCount: number } {
  if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) {
    throw new Error('Local gate re-verification failed: machine gate receipt is malformed');
  }
  const record = receipt as Record<string, unknown>;
  const fail = (reason: string): never => {
    throw new Error(`Local gate re-verification failed: ${reason}`);
  };
  if (record.version !== 1) fail('machine gate receipt has an unsupported version');
  if (record.status !== 'passed') {
    fail(`machine gate receipt status is ${String(record.status)}${record.errorCode ? ` (${String(record.errorCode)})` : ''}, not passed`);
  }
  if (typeof record.errorCode === 'string') fail(`machine gate receipt reports error code ${record.errorCode}`);
  if (typeof record.runId !== 'string' || record.runId.length === 0) fail('machine gate receipt has no runId');
  if (record.worktree !== expected.worktree || record.cwd !== expected.worktree) {
    fail('machine gate receipt was not written for this exact candidate worktree');
  }
  if (record.head !== expected.expectedHead) {
    fail(`machine gate receipt head ${String(record.head)} does not match the candidate worktree HEAD ${expected.expectedHead}`);
  }
  const startedAt = Date.parse(String(record.startedAt));
  const finishedAt = Date.parse(String(record.finishedAt));
  // Freshness: the receipt must come from this very invocation, not from a
  // previously-passed run that predates later edits to the candidate. The
  // bounds are two-sided: a receipt that claims to have started before this
  // invocation, or to finish in the future (beyond tolerated clock skew),
  // is stale or tampered and must fail closed.
  if (!Number.isFinite(startedAt) || startedAt < expected.startedMs - RECEIPT_CLOCK_SKEW_MS) {
    fail('machine gate receipt is stale: it was not produced by this re-verification run');
  }
  if (startedAt > expected.nowMs + RECEIPT_CLOCK_SKEW_MS) {
    fail('machine gate receipt is future-dated: its start timestamp is beyond the current time');
  }
  if (!Number.isFinite(finishedAt) || finishedAt < startedAt) {
    fail('machine gate receipt has an invalid completion timestamp');
  }
  if (finishedAt > expected.nowMs + RECEIPT_CLOCK_SKEW_MS) {
    fail('machine gate receipt is future-dated: its completion timestamp is beyond the current time');
  }
  if (record.configHash !== expected.expectedConfigHash) {
    fail('machine gate receipt does not match the controller-written gate configuration');
  }
  if (typeof record.contentHash !== 'string' || typeof record.finalContentHash !== 'string' ||
      record.contentHash.length === 0 || record.contentHash !== record.finalContentHash) {
    fail('input drift: candidate content changed between the gate run start and its end');
  }
  if (record.contentHash !== expected.preContentHash || record.finalContentHash !== expected.postContentHash) {
    fail('input drift: machine gate receipt does not match controller-observed candidate content');
  }
  if (!Array.isArray(record.gates)) fail('machine gate receipt has no gate list');
  const gates = record.gates as Array<Record<string, unknown>>;
  if (gates.length !== expected.gates.length) {
    fail(`machine gate receipt covers ${gates.length} gates but ${expected.gates.length} are configured`);
  }
  for (let index = 0; index < expected.gates.length; index += 1) {
    const configured = expected.gates[index] as GateDefinition;
    const ran = gates[index];
    if (ran === undefined || ran.id !== configured.id || ran.required !== configured.required) {
      fail(`configured gate ${configured.id} is not faithfully recorded in the machine gate receipt`);
    }
    if (configured.required) {
      if (ran.applicable !== true) fail(`required gate ${configured.id} was not applicable`);
      if (ran.status !== 'passed') fail(`required gate ${configured.id} did not pass (${String(ran.status)})`);
    } else if (ran.status !== 'passed' && ran.status !== 'not_applicable') {
      fail(`optional gate ${configured.id} did not pass (${String(ran.status)})`);
    }
  }
  return { runId: record.runId as string, head: record.head as string, gateCount: gates.length };
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// Keep this byte-for-byte compatible with the immutable runner's contentHash().
// The controller observes candidate bytes independently on both sides of the
// subprocess, so a self-consistent receipt cannot attest different bytes at
// those two boundaries. Exact committed bytes are still checked separately.
function controllerContentHash(worktree: string): string {
  const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: worktree,
    shell: false,
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error('Local gate re-verification failed: controller-side git evidence unavailable');
  }
  const names = [...new Set(result.stdout.toString('utf8').split('\0').filter(Boolean))].sort();
  const digest = createHash('sha256');
  for (const name of names) {
    if (name.startsWith('.qwen-harness/state/')) continue;
    const file = path.resolve(worktree, name);
    if (!file.startsWith(worktree + path.sep)) {
      throw new Error('Local gate re-verification failed: unsafe candidate path');
    }
    assertHashableParents(worktree, file);
    let stat;
    try {
      stat = lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      digest.update(JSON.stringify([name, 'missing']));
      continue;
    }
    if (stat.isSymbolicLink()) {
      digest.update(JSON.stringify([name, 'symlink', readlinkSync(file)]));
    } else if (stat.isFile()) {
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
          throw new Error('Local gate re-verification failed: candidate source changed while hashing');
        }
        digest.update(JSON.stringify([name, opened.mode & 0o777, sha256Hex(readFileSync(fd))]));
      } finally {
        closeSync(fd);
      }
    } else {
      throw new Error('Local gate re-verification failed: unsupported candidate source entry');
    }
  }
  return digest.digest('hex');
}

function assertHashableParents(worktree: string, file: string): void {
  const relative = path.relative(worktree, path.dirname(file));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Local gate re-verification failed: unsafe candidate path');
  }
  let current = worktree;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Local gate re-verification failed: unsafe candidate parent');
    }
  }
}

function safeLstat(target: string) {
  try {
    return lstatSync(target);
  } catch {
    return null;
  }
}
