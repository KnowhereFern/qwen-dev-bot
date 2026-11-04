import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Durable project-local usage ledger.
 *
 * Counts observed model token usage per project with two sources:
 * - Cumulative Qwen Code session snapshots: only the MAX observed total per
 *   session counts (repeated snapshots never sum). A lower later value is
 *   recorded as an anomaly but never lowers the observed total.
 * - Direct API calls: each completed response is counted once; retries that
 *   reuse the same callId are deduplicated. Missing or malformed usage marks
 *   the call unmetered, never zero.
 *
 * Only SHA-256 digests of caller-supplied opaque ids and nonnegative
 * integers are persisted. Identities are hashed whole rather than pattern
 * redacted: a secret-like session or call id must never reach the database
 * even when it matches no known secret pattern. No prompts, keys, raw
 * errors, or provider response text.
 */
export class UsageLedger {
  readonly databaseFile: string;
  private readonly db: DatabaseSync;

  constructor(
    readonly projectId: string,
    readonly stateDir: string,
  ) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.databaseFile = path.join(stateDir, 'usage.sqlite3');
    this.db = new DatabaseSync(this.databaseFile);
    chmodSync(this.databaseFile, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    // Additive schema only: new tables/columns may be added, never rewritten.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS qwen_sessions (
        session_id TEXT PRIMARY KEY,
        observed_total INTEGER NOT NULL,
        anomalies INTEGER NOT NULL DEFAULT 0,
        unmetered_snapshots INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS direct_calls (
        call_id TEXT PRIMARY KEY,
        observed_total INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS unmetered_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Record a cumulative usage snapshot for a Qwen Code session.
   * Counts only the maximum observed total; regression marks an anomaly.
   */
  recordQwenSessionSnapshot(sessionId: string | null | undefined, usage: unknown, now = Date.now()): void {
    const total = normalizeUsageTotal(usage);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (typeof sessionId !== 'string' || sessionId.trim() === '') {
        // Unknown session identity: mark unmetered, never fabricate one.
        this.recordUnmetered('qwen_session_unknown', now);
        this.db.exec('COMMIT');
        return;
      }
      const key = opaqueIdentity(sessionId);
      const row = this.db
        .prepare('SELECT observed_total, anomalies FROM qwen_sessions WHERE session_id = ?')
        .get(key) as { observed_total?: number | bigint; anomalies?: number | bigint } | undefined;
      if (!row) {
        if (total === null) {
          this.recordUnmetered('qwen_session_unknown', now);
        } else {
          this.db
            .prepare('INSERT INTO qwen_sessions(session_id, observed_total, anomalies, unmetered_snapshots, updated_at) VALUES (?, ?, 0, 0, ?)')
            .run(key, total, now);
        }
        this.db.exec('COMMIT');
        return;
      }
      const observed = Number(row.observed_total ?? 0);
      const anomalies = Number(row.anomalies ?? 0);
      if (total === null) {
        this.db
          .prepare('UPDATE qwen_sessions SET unmetered_snapshots = unmetered_snapshots + 1, updated_at = ? WHERE session_id = ?')
          .run(now, key);
        this.recordUnmetered('qwen_session_snapshot', now);
      } else if (total > observed) {
        this.db
          .prepare('UPDATE qwen_sessions SET observed_total = ?, updated_at = ? WHERE session_id = ?')
          .run(total, now, key);
      } else if (total < observed) {
        // Cumulative counter regressed: suspicious, but never lower the count.
        this.db
          .prepare('UPDATE qwen_sessions SET anomalies = ?, updated_at = ? WHERE session_id = ?')
          .run(anomalies + 1, now, key);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Record one completed direct API response. Duplicate callIds (retries,
   * replays) count once. Missing or malformed usage marks the call unmetered.
   */
  recordDirectApiUsage(callId: string | null | undefined, usage: unknown, now = Date.now()): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (typeof callId !== 'string' || callId.trim() === '') {
        this.recordUnmetered('direct_call_unknown', now);
        this.db.exec('COMMIT');
        return;
      }
      const key = opaqueIdentity(callId);
      const existing = this.db.prepare('SELECT 1 AS found FROM direct_calls WHERE call_id = ?').get(key);
      if (existing) {
        this.db.exec('COMMIT');
        return;
      }
      const total = normalizeUsageTotal(usage);
      if (total === null) this.recordUnmetered('direct_call', now);
      this.db.prepare('INSERT INTO direct_calls(call_id, observed_total, created_at) VALUES (?, ?, ?)').run(key, total, now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Aggregate observed usage and data-quality counters for this project's ledger. */
  summary(): UsageSummary {
    const sessions = this.db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(observed_total), 0) AS total, COALESCE(SUM(anomalies), 0) AS anomalies FROM qwen_sessions')
      .get() as { n?: number | bigint; total?: number | bigint; anomalies?: number | bigint };
    const calls = this.db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(observed_total), 0) AS total FROM direct_calls WHERE observed_total IS NOT NULL')
      .get() as { n?: number | bigint; total?: number | bigint };
    const unmetered = this.db.prepare('SELECT COUNT(*) AS n FROM unmetered_events').get() as { n?: number | bigint };
    return {
      projectId: this.projectId,
      observedTotalTokens: Number(sessions?.total ?? 0) + Number(calls?.total ?? 0),
      qwenSessionCount: Number(sessions?.n ?? 0),
      directCallCount: Number(calls?.n ?? 0),
      anomalyCount: Number(sessions?.anomalies ?? 0),
      unmeteredCount: Number(unmetered?.n ?? 0),
    };
  }

  private recordUnmetered(kind: string, now: number): void {
    this.db.prepare('INSERT INTO unmetered_events(kind, created_at) VALUES (?, ?)').run(kind, now);
  }
}

export interface UsageSummary {
  projectId: string;
  /** Sum of per-session maxima plus per-call totals; excludes unmetered entries. */
  observedTotalTokens: number;
  qwenSessionCount: number;
  directCallCount: number;
  anomalyCount: number;
  unmeteredCount: number;
}

/** Why an observed-token budget blocks new Qwen calls, when it does. */
export type UsageBudgetBlockReason = 'limit-reached' | 'unmetered-observation' | 'anomaly-observed';

export type UsageBudgetStatus =
  | {
      blocked: false;
      /** 'disabled' when no limit is configured, 'ok' when the budget allows calls. */
      reason: 'disabled' | 'ok';
      maxObservedTokens: number | null;
      observedTotalTokens: number;
    }
  | {
      blocked: true;
      reason: UsageBudgetBlockReason;
      maxObservedTokens: number;
      observedTotalTokens: number;
    };

/**
 * Pure observed-token budget decision from a ledger summary.
 *
 * A null limit keeps the budget off entirely. When configured, new calls are
 * blocked if the observed total has reached the limit, or if any unmetered or
 * anomalous observation was recorded since ledger activation — the observed
 * total is a lower bound then, so the budget fails closed on uncertainty.
 * Block reasons stay distinguishable for operators and tests.
 */
export function budgetStatus(
  summary: Pick<UsageSummary, 'observedTotalTokens' | 'anomalyCount' | 'unmeteredCount'>,
  maxObservedTokens: number | null,
): UsageBudgetStatus {
  const observedTotalTokens = summary.observedTotalTokens;
  if (maxObservedTokens === null) {
    return { blocked: false, reason: 'disabled', maxObservedTokens: null, observedTotalTokens };
  }
  if (observedTotalTokens >= maxObservedTokens) {
    return { blocked: true, reason: 'limit-reached', maxObservedTokens, observedTotalTokens };
  }
  if (summary.unmeteredCount > 0) {
    return { blocked: true, reason: 'unmetered-observation', maxObservedTokens, observedTotalTokens };
  }
  if (summary.anomalyCount > 0) {
    return { blocked: true, reason: 'anomaly-observed', maxObservedTokens, observedTotalTokens };
  }
  return { blocked: false, reason: 'ok', maxObservedTokens, observedTotalTokens };
}

/** Behavioral surface consumed by the API client, executor, and supervisor. */
export interface UsageBudgetController {
  /** Current budget decision against the project's usage ledger. */
  status(): UsageBudgetStatus;
}

/**
 * Opt-in cumulative observed-token budget bound to one project's usage
 * ledger. Deliberately distinct from the provider quota hold: a provider
 * hold parks tasks for a timed provider-wide reset, while this budget blocks
 * new Qwen calls on project-local observed evidence and only a configuration
 * change (or a fresh ledger) can lift it.
 */
export class ObservedTokenBudget implements UsageBudgetController {
  constructor(
    readonly maxObservedTokens: number | null,
    private readonly ledger: UsageLedger,
  ) {}

  status(): UsageBudgetStatus {
    return budgetStatus(this.ledger.summary(), this.maxObservedTokens);
  }
}

/**
 * Thrown when the configured observed-token budget blocks a new Qwen call,
 * before any request or process spawn is attempted. Callers must treat this
 * as a parking signal, never as a task failure.
 */
export class UsageBudgetActiveError extends Error {
  constructor(readonly status: UsageBudgetStatus & { blocked: true }) {
    super(
      status.reason === 'limit-reached'
        ? `Observed-token budget reached: ${status.observedTotalTokens} observed of ${status.maxObservedTokens} allowed; call blocked without an attempt`
        : status.reason === 'unmetered-observation'
          ? 'Observed-token budget blocked: unmetered usage observation recorded since ledger activation; call blocked without an attempt'
          : 'Observed-token budget blocked: anomalous usage observation recorded since ledger activation; call blocked without an attempt',
    );
    this.name = 'UsageBudgetActiveError';
  }
}

/**
 * Normalize a Qwen Code or direct API usage payload to a total token count.
 * Fields may be nested arbitrarily deep. Accepts total_tokens, or
 * input_tokens + output_tokens, or prompt_tokens + completion_tokens.
 * Returns null when usage is missing or malformed — the caller must treat
 * that as unmetered, never zero.
 */
export function normalizeUsageTotal(usage: unknown): number | null {
  if (!usage || typeof usage !== 'object') return null;
  const values = collectTokenValues(usage);
  const total = asTokens(values.get('total_tokens'));
  if (total !== null) return total;
  const input = asTokens(values.get('input_tokens')) ?? asTokens(values.get('prompt_tokens'));
  const output = asTokens(values.get('output_tokens')) ?? asTokens(values.get('completion_tokens'));
  if (input !== null && output !== null) {
    const combined = input + output;
    return Number.isSafeInteger(combined) ? combined : null;
  }
  return null;
}

/** Collect the first valid nonnegative integer per field name, searching nested objects. */
function collectTokenValues(value: unknown, found = new Map<string, number>()): Map<string, number> {
  if (!value || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child && typeof child === 'object') {
      collectTokenValues(child, found);
      continue;
    }
    if (!found.has(key)) {
      const tokens = asTokens(child);
      if (tokens !== null) found.set(key, tokens);
    }
  }
  return found;
}

/** Safe nonnegative integer check: no floats, NaN, negatives, or numeric strings. */
function asTokens(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

/**
 * Deterministic SHA-256 digest of a caller-supplied opaque identity. Hashing
 * (not pattern redaction) guarantees the raw id — which may resemble a secret
 * — is never persisted, while identical ids still dedupe to one row.
 */
function opaqueIdentity(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}
