import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_QWEN_BASE_URL } from './runtime-compat.js';
import {
  PROVIDER_RESET_MAX_FUTURE_MS,
  PROVIDER_RESET_SAFETY_MARGIN_MS,
} from './provider-reset.js';

/** A confirmed monthly-quota hold never waits less than this, even on the
 * first occurrence without an admitted reset timestamp. */
export const QUOTA_HOLD_MIN_WAIT_MS = 60 * 60 * 1_000;
/** Hard cap for exponential quota-hold backoff without an admitted reset. */
export const QUOTA_HOLD_MAX_WAIT_MS = 24 * 60 * 60 * 1_000;
/** Doubling stops here so the exponent can never overflow. */
const QUOTA_HOLD_MAX_EXPONENT = 20;
/** The only hold classifications applyHold accepts; raw provider text is
 * never persisted as a kind. */
const QUOTA_HOLD_KINDS = new Set(['insufficient_quota', 'qwen_code_quota']);

/**
 * The sanitized provider route identity of a Qwen credential route: base
 * URL and model only. The credential environment variable name is carried
 * for validation but is NOT part of the durable route key. The credential
 * value itself is never part of the route and never persisted.
 */
export interface ProviderRoute {
  baseUrl: string;
  model: string;
  credentialEnvKey: string;
}

/**
 * Canonicalized route identity. The baseUrl is parsed as a strict HTTPS URL
 * with no username, password, query, or fragment components; the origin is
 * lowercased (hosts are case-insensitive) while the path keeps its case
 * (URL paths may be case-sensitive). Only then is a SHA-256 digest of the
 * canonical route persisted, so neither the endpoint URL nor the credential
 * environment variable name (nor any credential material) ever reaches the
 * database. The credential env variable name is deliberately NOT part of the
 * key: provider-wide monthly quota is shared across every credential that
 * hits the same endpoint and model, so the hold must be too. This is
 * intentionally conservative when distinct accounts share a route.
 */
export function providerRouteKey(route: ProviderRoute): string {
  const model = route.model.trim().toLowerCase();
  if (!route.baseUrl.trim() || !model || !route.credentialEnvKey.trim()) {
    throw new Error('Provider route requires baseUrl, model, and credentialEnvKey');
  }
  let endpoint: URL;
  try {
    endpoint = new URL(route.baseUrl.trim());
  } catch {
    throw new Error('Provider route baseUrl must be a valid absolute URL');
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Provider route baseUrl must be HTTPS without embedded credentials, query, or fragment');
  }
  const canonicalBaseUrl = `${endpoint.origin.toLowerCase()}${endpoint.pathname.replace(/\/+$/, '')}`;
  return createHash('sha256')
    .update(`${canonicalBaseUrl}|${model}`)
    .digest('hex');
}

/** Resolve the provider route for a project config's `qwen` block. */
export function providerRouteFromConfig(qwen: { baseUrl?: string; model: string; credentialEnvKey?: string }): ProviderRoute {
  return {
    baseUrl: qwen.baseUrl ?? DEFAULT_QWEN_BASE_URL,
    model: qwen.model,
    credentialEnvKey: qwen.credentialEnvKey ?? 'DASHSCOPE_API_KEY',
  };
}

export interface QuotaHoldApplyInput {
  /** Admitted strict reset timestamp, when the provider supplied one. */
  resetAt?: number | null;
  /** Short, sanitized classification of the confirmed signal (no raw
   * errors, prompts, or secrets). */
  kind: string;
  now?: number;
}

/** Behavioral surface consumed by the API client, executor, and supervisor. */
export interface QuotaHoldController {
  /** Epoch ms until which this route is held, or null when not held. */
  heldUntil(route: ProviderRoute, now?: number): number | null;
  /** Persist (or extend) a hold and return the effective held-until. */
  applyHold(route: ProviderRoute, input: QuotaHoldApplyInput): number;
}

/**
 * Durable, cross-project provider-wide quota circuit breaker, keyed by the
 * sanitized provider route and stored at the harness state root in its own
 * SQLite database. All writes run inside BEGIN IMMEDIATE transactions and
 * holds are monotonic: a new hold can only extend a still-live hold, never
 * shorten it.
 */
export class ProviderQuotaHold implements QuotaHoldController {
  readonly databaseFile: string;
  private readonly db: DatabaseSync;

  constructor(stateRoot: string) {
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    this.databaseFile = path.join(stateRoot, 'provider-holds.sqlite3');
    this.db = new DatabaseSync(this.databaseFile);
    chmodSync(this.databaseFile, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_holds (
        route_key TEXT PRIMARY KEY,
        held_until INTEGER NOT NULL,
        kind TEXT NOT NULL,
        occurrences INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  heldUntil(route: ProviderRoute, now = Date.now()): number | null {
    const row = this.db
      .prepare('SELECT held_until FROM provider_holds WHERE route_key = ?')
      .get(providerRouteKey(route)) as { held_until?: number | bigint } | undefined;
    const heldUntil = Number(row?.held_until ?? Number.NaN);
    return Number.isFinite(heldUntil) && heldUntil > now ? heldUntil : null;
  }

  applyHold(route: ProviderRoute, input: QuotaHoldApplyInput): number {
    const now = input.now ?? Date.now();
    if (!Number.isFinite(now)) throw new Error('applyHold requires a finite now');
    if (!QUOTA_HOLD_KINDS.has(input.kind)) {
      throw new Error(`applyHold kind must be one of ${[...QUOTA_HOLD_KINDS].join(', ')}`);
    }
    // Admit a reset only inside the strict future 32-day horizon; anything
    // else (past, non-finite, or years out) falls back to bounded backoff so
    // a malformed input can never persist a years-long hold.
    let resetAt = input.resetAt ?? null;
    if (resetAt !== null && (!Number.isFinite(resetAt) || resetAt <= now || resetAt - now > PROVIDER_RESET_MAX_FUTURE_MS)) {
      resetAt = null;
    }
    const key = providerRouteKey(route);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare('SELECT held_until, occurrences FROM provider_holds WHERE route_key = ?')
        .get(key) as { held_until?: number | bigint; occurrences?: number | bigint } | undefined;
      const previousUntil = Number(row?.held_until ?? 0);
      const occurrences = Number(row?.occurrences ?? 0) + 1;
      // With an admitted strict reset: hold until reset + safety margin.
      // Without one: bounded exponential wait starting at no less than one
      // hour, doubling per occurrence, capped at 24 hours.
      const target = resetAt !== null && Number.isFinite(resetAt)
        ? Math.max(now + QUOTA_HOLD_MIN_WAIT_MS, resetAt + PROVIDER_RESET_SAFETY_MARGIN_MS)
        : now + quotaBackoffWaitMs(occurrences);
      // Monotonic: a still-live hold is never shortened.
      const heldUntil = Math.max(target, previousUntil > now ? previousUntil : target);
      this.db
        .prepare(
          `INSERT INTO provider_holds(route_key, held_until, kind, occurrences, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(route_key) DO UPDATE SET
             held_until=excluded.held_until, kind=excluded.kind,
             occurrences=excluded.occurrences, updated_at=excluded.updated_at`,
        )
        .run(key, heldUntil, input.kind.slice(0, 64), occurrences, now);
      this.db.exec('COMMIT');
      return heldUntil;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Test/inspection helper: sanitized dump of persisted rows. */
  inspect(): Array<{ routeKey: string; heldUntil: number; kind: string; occurrences: number }> {
    return (this.db.prepare('SELECT * FROM provider_holds ORDER BY route_key').all() as Array<Record<string, unknown>>).map(
      (row) => ({
        routeKey: String(row.route_key),
        heldUntil: Number(row.held_until),
        kind: String(row.kind),
        occurrences: Number(row.occurrences),
      }),
    );
  }
}

function quotaBackoffWaitMs(occurrences: number): number {
  const exponent = Math.min(Math.max(Math.trunc(occurrences) || 1, 1) - 1, QUOTA_HOLD_MAX_EXPONENT);
  return Math.min(QUOTA_HOLD_MIN_WAIT_MS * 2 ** exponent, QUOTA_HOLD_MAX_WAIT_MS);
}

/**
 * Thrown when a provider route is currently held, before any request or
 * process spawn is attempted. Callers must treat this as a parking signal,
 * never as a task failure.
 */
export class QuotaHoldActiveError extends Error {
  constructor(readonly heldUntil: number | null) {
    super(
      heldUntil !== null
        ? `Provider quota hold active until ${new Date(heldUntil).toISOString()}; request blocked without an attempt`
        : 'Provider monthly quota is exhausted; request blocked without an attempt',
    );
    this.name = 'QuotaHoldActiveError';
  }
}
