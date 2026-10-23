import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { budgetStatus, UsageBudgetActiveError, UsageLedger, normalizeUsageTotal, ObservedTokenBudget } from '../src/core/usage-ledger.js';
import { makeTmp } from './helpers.js';

describe('UsageLedger', () => {
  it('counts duplicate cumulative snapshots of one session as MAX, not sum', () => {
    const store = new UsageLedger('project-a', makeTmp('usage-duplicate-snapshot'));
    store.recordQwenSessionSnapshot('session-1', { total_tokens: 100 });
    store.recordQwenSessionSnapshot('session-1', { total_tokens: 350 });
    store.recordQwenSessionSnapshot('session-1', { total_tokens: 350 });
    expect(store.summary()).toMatchObject({ observedTotalTokens: 350, qwenSessionCount: 1, anomalyCount: 0, unmeteredCount: 0 });
    store.close();
  });

  it('marks a regressed cumulative snapshot as an anomaly without lowering the count', () => {
    const store = new UsageLedger('project-a', makeTmp('usage-regression'));
    store.recordQwenSessionSnapshot('session-1', { total_tokens: 500 });
    store.recordQwenSessionSnapshot('session-1', { total_tokens: 200 });
    store.recordQwenSessionSnapshot('session-1', { total_tokens: 200 });
    expect(store.summary()).toMatchObject({ observedTotalTokens: 500, anomalyCount: 2, unmeteredCount: 0 });
    store.close();
  });

  it('sums separate sessions independently', () => {
    const store = new UsageLedger('project-a', makeTmp('usage-separate-sessions'));
    store.recordQwenSessionSnapshot('session-1', { input_tokens: 30, output_tokens: 70 });
    store.recordQwenSessionSnapshot('session-2', { prompt_tokens: 40, completion_tokens: 60 });
    store.recordQwenSessionSnapshot('session-2', { prompt_tokens: 50, completion_tokens: 50 });
    expect(store.summary()).toMatchObject({ observedTotalTokens: 100 + 100, qwenSessionCount: 2 });
    store.close();
  });

  it('normalizes nested usage field shapes to a single total', () => {
    expect(normalizeUsageTotal({ total_tokens: 42 })).toBe(42);
    expect(normalizeUsageTotal({ usage: { input_tokens: 10, output_tokens: 5 } })).toBe(15);
    expect(normalizeUsageTotal({ usage: { prompt_tokens: 9, completion_tokens: 1 } })).toBe(10);
    expect(normalizeUsageTotal({ usage: { input_tokens: 10.5, output_tokens: 5 } })).toBeNull();
    expect(normalizeUsageTotal({ usage: { input_tokens: -1, output_tokens: 5 } })).toBeNull();
    expect(normalizeUsageTotal({ usage: { input_tokens: '10', output_tokens: 5 } })).toBeNull();
    expect(normalizeUsageTotal({ input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 })).toBeNull();
    expect(normalizeUsageTotal(null)).toBeNull();
    expect(normalizeUsageTotal({})).toBeNull();
  });

  it('deduplicates direct API calls by callId so retries count once', () => {
    const store = new UsageLedger('project-a', makeTmp('usage-direct-dedupe'));
    store.recordDirectApiUsage('call-1', { total_tokens: 25 });
    store.recordDirectApiUsage('call-1', { total_tokens: 25 });
    store.recordDirectApiUsage('call-2', { total_tokens: 10 });
    expect(store.summary()).toMatchObject({ observedTotalTokens: 35, directCallCount: 2, unmeteredCount: 0 });
    store.close();
  });

  it('marks malformed or missing direct-call usage unmetered, never zero', () => {
    const store = new UsageLedger('project-a', makeTmp('usage-missing'));
    store.recordDirectApiUsage('call-1', undefined);
    store.recordDirectApiUsage('call-2', { usage: { total_tokens: Number.NaN } });
    store.recordQwenSessionSnapshot('session-1', { unrelated: true });
    const summary = store.summary();
    expect(summary.observedTotalTokens).toBe(0);
    expect(summary.unmeteredCount).toBe(3);
    expect(summary.qwenSessionCount).toBe(0);
    expect(summary.directCallCount).toBe(0);
    store.close();
  });

  it('marks unknown sessionIds unmetered without fabricating identity', () => {
    const store = new UsageLedger('project-a', makeTmp('usage-unknown-session'));
    store.recordQwenSessionSnapshot(undefined, { total_tokens: 999 });
    store.recordQwenSessionSnapshot('   ', { total_tokens: 999 });
    const summary = store.summary();
    expect(summary.observedTotalTokens).toBe(0);
    expect(summary.qwenSessionCount).toBe(0);
    expect(summary.unmeteredCount).toBe(2);
    store.close();
  });

  it('persists all counters across a restart', () => {
    const dir = makeTmp('usage-restart');
    let store = new UsageLedger('project-a', dir);
    store.recordQwenSessionSnapshot('session-1', { total_tokens: 100 });
    store.recordQwenSessionSnapshot('session-1', { total_tokens: 50 });
    store.recordQwenSessionSnapshot('session-2', { total_tokens: 75 });
    store.recordDirectApiUsage('call-1', { total_tokens: 25 });
    store.recordDirectApiUsage('call-2', undefined);
    store.close();

    store = new UsageLedger('project-a', dir);
    // Replayed snapshots after restart must stay idempotent.
    store.recordQwenSessionSnapshot('session-1', { total_tokens: 100 });
    store.recordDirectApiUsage('call-1', { total_tokens: 25 });
    expect(store.summary()).toEqual({
      projectId: 'project-a',
      observedTotalTokens: 200,
      qwenSessionCount: 2,
      directCallCount: 1,
      anomalyCount: 1,
      unmeteredCount: 1,
    });
    store.close();
  });

  it('persists no prompts, keys, raw errors, or provider text in the ledger file', () => {
    const dir = makeTmp('usage-no-sensitive-data');
    const store = new UsageLedger('project-a', dir);
    store.recordQwenSessionSnapshot('session-abc123', {
      total_tokens: 10,
      prompt: 'SECRET PROMPT with api_key=sk-abcdefgh123456',
      error: 'provider exploded at https://user:hunter2@example.com',
    });
    store.recordDirectApiUsage('call-secret-token-x987654321', { total_tokens: 5, raw_response: 'Bearer sk-live_abcdefgh123456' });
    store.close();
    const raw = readFileSync(path.join(dir, 'usage.sqlite3'), 'utf8');
    expect(raw).not.toContain('SECRET PROMPT');
    expect(raw).not.toContain('api_key');
    expect(raw).not.toContain('sk-');
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('Bearer');
    expect(raw).not.toContain('provider exploded');
  });

  it('persists hashed identities only: supplied secret-like session and call ids never reach the DB, and dedupe still works', () => {
    const dir = makeTmp('usage-hashed-identity');
    const secretSession = 'sk-session_abcdefgh123456';
    const secretCall = 'token-secret-call-998877665544';
    const store = new UsageLedger('project-a', dir);
    store.recordQwenSessionSnapshot(secretSession, { total_tokens: 12 });
    store.recordDirectApiUsage(secretCall, { total_tokens: 8 });
    store.recordDirectApiUsage(secretCall, { total_tokens: 8 });
    store.close();
    const raw = readFileSync(path.join(dir, 'usage.sqlite3'), 'utf8');
    expect(raw).not.toContain(secretSession);
    expect(raw).not.toContain(secretCall);
    // Identical ids hash identically (dedupe intact) across a restart too.
    const reopened = new UsageLedger('project-a', dir);
    try {
      reopened.recordDirectApiUsage(secretCall, { total_tokens: 8 });
      reopened.recordQwenSessionSnapshot(secretSession, { total_tokens: 12 });
      expect(reopened.summary()).toMatchObject({
        observedTotalTokens: 20,
        qwenSessionCount: 1,
        directCallCount: 1,
        unmeteredCount: 0,
        anomalyCount: 0,
      });
    } finally {
      reopened.close();
    }
  });
});

describe('observed-token budget status', () => {
  const summary = (observedTotalTokens: number, anomalyCount = 0, unmeteredCount = 0) =>
    ({ observedTotalTokens, anomalyCount, unmeteredCount });

  it('stays disabled and never blocks without a configured limit', () => {
    expect(budgetStatus(summary(9_999_999, 5, 7), null)).toEqual({
      blocked: false, reason: 'disabled', maxObservedTokens: null, observedTotalTokens: 9_999_999,
    });
  });

  it('allows calls below the limit with a clean ledger', () => {
    expect(budgetStatus(summary(99), 100)).toEqual({
      blocked: false, reason: 'ok', maxObservedTokens: 100, observedTotalTokens: 99,
    });
  });

  it('blocks once the observed total reaches the configured limit', () => {
    expect(budgetStatus(summary(100), 100)).toMatchObject({ blocked: true, reason: 'limit-reached' });
    expect(budgetStatus(summary(150), 100)).toMatchObject({ blocked: true, reason: 'limit-reached' });
  });

  it('fails closed on unmetered or anomalous observations below the limit, with distinct reasons', () => {
    expect(budgetStatus(summary(10, 0, 1), 100)).toMatchObject({ blocked: true, reason: 'unmetered-observation' });
    expect(budgetStatus(summary(10, 2, 0), 100)).toMatchObject({ blocked: true, reason: 'anomaly-observed' });
  });

  it('prefers the deterministic limit-reached reason over uncertainty reasons', () => {
    expect(budgetStatus(summary(100, 1, 1), 100)).toMatchObject({ blocked: true, reason: 'limit-reached' });
  });

  it('binds a budget to the live ledger state through ObservedTokenBudget', () => {
    const store = new UsageLedger('budget-project', makeTmp('usage-budget-controller'));
    const budget = new ObservedTokenBudget(100, store);
    try {
      expect(budget.status()).toMatchObject({ blocked: false, reason: 'ok' });
      store.recordDirectApiUsage('call-1', { total_tokens: 100 });
      const status = budget.status();
      expect(status).toMatchObject({ blocked: true, reason: 'limit-reached' });
      if (status.blocked) expect(new UsageBudgetActiveError(status).message).toContain('Observed-token budget reached');
    } finally { store.close(); }
  });
});
