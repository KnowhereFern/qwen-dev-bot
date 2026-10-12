import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
 * left exactly as the Qwen handoff produced it. Any missing runner, invalid
 * receipt, or failed check throws — callers must fail closed.
 */
export async function runLocalGateReverification(options: LocalGateReverificationOptions): Promise<LocalGateReverification> {
  const worktree = realpathSync(options.worktreePath);
  const runnerPath = immutableGateRunnerPath();
  if (runnerPath === null) {
    throw new Error(
      'Local gate re-verification failed: immutable controller runner template/.qwen-harness/scripts/run-gates.mjs is missing or not a regular file',
    );
  }

  const harnessDir = path.join(worktree, '.qwen-harness');
  const configPath = path.join(harnessDir, 'project.yml');
  const receiptPath = path.join(harnessDir, 'state', 'gate-receipt.json');

  const harnessStat = safeLstat(harnessDir);
  if (harnessStat !== null && (harnessStat.isSymbolicLink() || !harnessStat.isDirectory())) {
    throw new Error('Local gate re-verification failed: .qwen-harness in the candidate worktree is not a real directory');
  }
  const configStat = safeLstat(configPath);
  if (configStat !== null && configStat.isSymbolicLink()) {
    throw new Error('Local gate re-verification failed: .qwen-harness/project.yml in the candidate worktree is a symlink');
  }
  const priorConfig = configStat !== null && configStat.isFile() ? readFileSync(configPath) : null;

  try {
    mkdirSync(harnessDir, { recursive: true });
    // The authoritative gate set comes from the controller config. A tracked
    // project.yml edited by the implementer during the session is never
    // trusted to define (or drop) required gates.
    writeFileSync(configPath, `${JSON.stringify({ gates: options.gates }, null, 2)}\n`);

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

    const receiptStat = safeLstat(receiptPath);
    if (receiptStat === null || receiptStat.isSymbolicLink() || !receiptStat.isFile()) {
      throw new Error('Local gate re-verification failed: no regular machine gate receipt was written in the candidate worktree');
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
      gates: options.gates,
    });
    return { runId: verified.runId, head: verified.head, gateCount: verified.gateCount };
  } finally {
    // Leave the candidate worktree exactly as the Qwen handoff produced it:
    // restore any pre-existing project.yml bytes and drop harness-owned
    // re-verification state (including any stale previously-passed receipt,
    // which must never survive as seemingly-fresh evidence) so no gate
    // artifact can ride into the commit.
    try {
      if (priorConfig === null) rmSync(configPath, { force: true });
      else writeFileSync(configPath, priorConfig);
    } catch { /* cleanup is best-effort; commit-side checks still fail closed */ }
    try {
      rmSync(receiptPath, { force: true });
    } catch { /* best-effort */ }
  }
}

function validateReceipt(
  receipt: unknown,
  expected: { worktree: string; expectedHead: string; startedMs: number; gates: GateDefinition[] },
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
  // previously-passed run that predates later edits to the candidate.
  if (!Number.isFinite(startedAt) || startedAt < expected.startedMs - 5_000) {
    fail('machine gate receipt is stale: it was not produced by this re-verification run');
  }
  if (!Number.isFinite(finishedAt) || finishedAt < startedAt) {
    fail('machine gate receipt has an invalid completion timestamp');
  }
  if (typeof record.contentHash !== 'string' || typeof record.finalContentHash !== 'string' ||
      record.contentHash.length === 0 || record.contentHash !== record.finalContentHash) {
    fail('input drift: candidate content changed between the gate run start and its end');
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

function safeLstat(target: string) {
  try {
    return lstatSync(target);
  } catch {
    return null;
  }
}
