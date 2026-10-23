import { describe, expect, it } from 'vitest';
import { defaultProjectConfig } from '../src/core/config.js';
import { makeTmp } from './helpers.js';
import {
  ProviderQuotaHold,
  providerRouteFromConfig,
  providerRouteKey,
  QuotaHoldActiveError,
  QUOTA_HOLD_MAX_WAIT_MS,
  QUOTA_HOLD_MIN_WAIT_MS,
} from '../src/qwen/quota-hold.js';

const route = { baseUrl: 'https://api.example.com/v1/', model: 'qwen3.8-max', credentialEnvKey: 'DASHSCOPE_API_KEY' };
const otherRoute = { baseUrl: 'https://other.example.com/v1', model: 'qwen3.8-max', credentialEnvKey: 'DASHSCOPE_API_KEY' };

describe('Provider quota hold', () => {
  it('persists only a SHA-256 route identity of a canonical HTTPS URL', () => {
    const key = providerRouteKey(route);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    // No endpoint URL or credential environment name in the persisted key.
    expect(key).not.toContain('api.example.com');
    expect(key).not.toContain('DASHSCOPE');
    expect(providerRouteKey({ ...route, baseUrl: 'HTTPS://API.EXAMPLE.COM/v1' })).toBe(key);
    expect(providerRouteKey({ ...route, baseUrl: 'https://api.example.com/v1///' })).toBe(key);
    expect(providerRouteKey(otherRoute)).not.toBe(key);
    expect(() => providerRouteKey({ ...route, baseUrl: ' ' })).toThrow();
    // Credential-bearing or non-canonical URLs are rejected outright.
    expect(() => providerRouteKey({ ...route, baseUrl: 'https://user:pass@api.example.com/v1' })).toThrow();
    expect(() => providerRouteKey({ ...route, baseUrl: 'https://api.example.com/v1?token=secret' })).toThrow();
    expect(() => providerRouteKey({ ...route, baseUrl: 'https://api.example.com/v1#secret' })).toThrow();
    expect(() => providerRouteKey({ ...route, baseUrl: 'http://api.example.com/v1' })).toThrow();
    expect(() => providerRouteKey({ ...route, baseUrl: 'not-a-url' })).toThrow();
  });

  it('shares one hold across different credential env keys on the same endpoint+model, across instances', () => {
    const root = holdRoot('shared-env-keys');
    const now = Date.now();
    const resetAt = now + 4 * 60 * 60 * 1_000;
    const patentBetaRoute = { baseUrl: 'https://api.example.com/v1', model: 'qwen3.8-max', credentialEnvKey: 'DASHSCOPE_API_KEY' };
    const festivalSosRoute = { baseUrl: 'https://api.example.com/v1', model: 'qwen3.8-max', credentialEnvKey: 'BAILIAN_TOKEN_PLAN_API_KEY' };
    const first = new ProviderQuotaHold(root);
    const heldUntil = first.applyHold(patentBetaRoute, { resetAt, kind: 'insufficient_quota', now });
    first.close();
    // A second instance (other project) with a different env key reads the SAME hold.
    const second = new ProviderQuotaHold(root);
    try {
      expect(providerRouteKey(festivalSosRoute)).toBe(providerRouteKey(patentBetaRoute));
      expect(second.heldUntil(festivalSosRoute, now)).toBe(heldUntil);
      expect(second.inspect()).toHaveLength(1);
    } finally { second.close(); }
  });

  it('keeps different URL path case distinct in the route key', () => {
    const root = holdRoot('path-case');
    const hold = new ProviderQuotaHold(root);
    try {
      const lowerPath = providerRouteKey({ ...route, baseUrl: 'https://api.example.com/v1' });
      const upperPath = providerRouteKey({ ...route, baseUrl: 'https://api.example.com/V1' });
      expect(upperPath).not.toBe(lowerPath);
      const now = Date.now();
      const resetAt = now + 2 * 60 * 60 * 1_000;
      const heldUntil = hold.applyHold({ ...route, baseUrl: 'https://api.example.com/v1' }, { resetAt, kind: 'insufficient_quota', now });
      expect(hold.heldUntil({ ...route, baseUrl: 'https://api.example.com/V1' }, now)).toBeNull();
      expect(hold.heldUntil({ ...route, baseUrl: 'https://api.example.com/v1' }, now)).toBe(heldUntil);
    } finally { hold.close(); }
  });

  it('resolves a config route with provider defaults', () => {
    const config = defaultProjectConfig('/tmp/project', 'test', 'owner/repo');
    expect(providerRouteFromConfig(config.qwen)).toEqual({
      baseUrl: config.qwen.baseUrl,
      model: config.qwen.model,
      credentialEnvKey: config.qwen.credentialEnvKey,
    });
  });

  it('holds until an admitted reset plus the safety margin', () => {
    const hold = new ProviderQuotaHold(holdRoot('reset'));
    try {
      const now = Date.UTC(2026, 0, 22, 12, 0, 0);
      const resetAt = now + 6 * 60 * 60 * 1_000;
      const heldUntil = hold.applyHold(route, { resetAt, kind: 'insufficient_quota', now });
      expect(heldUntil).toBe(resetAt + 5 * 60_000);
      expect(hold.heldUntil(route, now + heldUntil - now - 1)).toBe(heldUntil);
      expect(hold.heldUntil(route, heldUntil)).toBeNull();
    } finally { hold.close(); }
  });

  it('falls back to bounded exponential waits starting at one hour, capped at 24h', () => {
    const hold = new ProviderQuotaHold(holdRoot('backoff'));
    try {
      const now = 1_000_000;
      const first = hold.applyHold(route, { kind: 'insufficient_quota', now });
      const second = hold.applyHold(route, { kind: 'insufficient_quota', now });
      const third = hold.applyHold(route, { kind: 'insufficient_quota', now });
      expect(first).toBeGreaterThanOrEqual(now + QUOTA_HOLD_MIN_WAIT_MS);
      expect(second).toBe(now + 2 * QUOTA_HOLD_MIN_WAIT_MS);
      expect(third).toBe(now + 4 * QUOTA_HOLD_MIN_WAIT_MS);
      for (let i = 0; i < 30; i += 1) hold.applyHold(route, { kind: 'insufficient_quota', now });
      const capped = hold.applyHold(route, { kind: 'insufficient_quota', now });
      expect(capped - now).toBeLessThanOrEqual(QUOTA_HOLD_MAX_WAIT_MS);
    } finally { hold.close(); }
  });

  it('never shortens a still-live hold', () => {
    const hold = new ProviderQuotaHold(holdRoot('monotonic'));
    try {
      const now = 1_000_000;
      const resetAt = now + 20 * 60 * 60 * 1_000;
      const long = hold.applyHold(route, { resetAt, kind: 'insufficient_quota', now });
      // A later fallback hold (1h) must not pull the live reset-based hold earlier.
      const shortened = hold.applyHold(route, { kind: 'insufficient_quota', now });
      expect(shortened).toBe(long);
      expect(hold.heldUntil(route, now)).toBe(long);
    } finally { hold.close(); }
  });

  it('survives a restart and is shared across projects on the same route', () => {
    const root = holdRoot('restart');
    const now = Date.now();
    const resetAt = now + 3 * 60 * 60 * 1_000;
    const first = new ProviderQuotaHold(root);
    const heldUntil = first.applyHold(route, { resetAt, kind: 'insufficient_quota', now });
    first.close();
    // A new instance (fresh process/project) reads the same durable hold.
    const second = new ProviderQuotaHold(root);
    try {
      expect(second.heldUntil(route, now)).toBe(heldUntil);
      expect(second.heldUntil(otherRoute, now)).toBeNull();
      expect(second.inspect()).toHaveLength(1);
    } finally { second.close(); }
  });

  it('stores no endpoint or credential material in global state', () => {
    const root = holdRoot('secrets');
    const hold = new ProviderQuotaHold(root);
    try {
      hold.applyHold(
        { baseUrl: 'https://api.example.com/v1', model: 'qwen3.8-max', credentialEnvKey: 'SECRET_ENV_NAME' },
        { kind: 'insufficient_quota', now: Date.now() },
      );
      const rows = hold.inspect();
      expect(rows).toHaveLength(1);
      // Only an opaque SHA-256 route identity is persisted: no URL, no env name.
      expect(rows[0]!.routeKey).toMatch(/^[0-9a-f]{64}$/);
      const text = JSON.stringify(rows);
      expect(text).not.toContain('SECRET_ENV_NAME');
      expect(text).not.toContain('api.example.com');
      expect(text).not.toMatch(/sk-[A-Za-z0-9]/);
      expect(text).not.toContain('Bearer ');
    } finally { hold.close(); }
  });

  it('validates hold inputs: enum kinds only, resets inside the future 32-day horizon', () => {
    const hold = new ProviderQuotaHold(holdRoot('validation'));
    try {
      const now = 1_000_000_000;
      expect(() => hold.applyHold(route, { kind: 'Rate limit exceeded, quota is exhausted. Reset at 2030-01-01 UTC', now })).toThrow();
      expect(() => hold.applyHold(route, { kind: '', now })).toThrow();
      // A years-long reset is not admitted: falls back to bounded backoff.
      const far = hold.applyHold(route, { resetAt: now + 365 * 24 * 60 * 60 * 1_000, kind: 'insufficient_quota', now });
      expect(far - now).toBeLessThanOrEqual(QUOTA_HOLD_MAX_WAIT_MS);
      // A past or non-finite reset likewise falls back.
      const past = hold.applyHold(route, { resetAt: now - 1_000, kind: 'qwen_code_quota', now });
      expect(past).toBeGreaterThan(now);
    } finally { hold.close(); }
  });

  it('reports a blocked request through QuotaHoldActiveError without an attempt', () => {
    const error = new QuotaHoldActiveError(1_234);
    expect(error.name).toBe('QuotaHoldActiveError');
    expect(error.heldUntil).toBe(1_234);
    expect(new QuotaHoldActiveError(null).heldUntil).toBeNull();
  });
});

let counter = 0;
function holdRoot(prefix: string): string {
  counter += 1;
  return makeTmp(`quota-hold-${prefix}-${counter}`);
}
