import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_QWEN_API_TIMEOUT_MS, QwenApiClient } from '../src/qwen/qwen-api.js';
import { isMonthlyQuotaExhaustion, parseProviderResetAt } from '../src/qwen/provider-reset.js';
import { ProviderQuotaHold, QuotaHoldActiveError } from '../src/qwen/quota-hold.js';
import { UsageBudgetActiveError, ObservedTokenBudget, UsageLedger } from '../src/core/usage-ledger.js';
import { makeTmp } from './helpers.js';

describe('monthly quota exhaustion classification', () => {
  it('matches structured insufficient_quota and real token-plan month-scope exhaustion only', () => {
    // Structured API error code.
    expect(isMonthlyQuotaExhaustion('{"error":{"code":"insufficient_quota","message":"quota exceeded"}}')).toBe(true);
    // Exact observed token-plan wording.
    expect(isMonthlyQuotaExhaustion(
      'Quota exhausted: Your token-plan 1-month quota has been exhausted. The quota will reset at 11-05 16:00:00 UTC',
    )).toBe(true);
    expect(isMonthlyQuotaExhaustion('Your monthly quota has been exhausted')).toBe(true);
    // Generic quota / rate-limit prose must NOT trigger a provider-wide hold.
    expect(isMonthlyQuotaExhaustion('Quota exhausted. Reset at 03-01 00:00:00 UTC')).toBe(false);
    expect(isMonthlyQuotaExhaustion('rate limit exceeded')).toBe(false);
    expect(isMonthlyQuotaExhaustion('requests quota exceeded, please slow down')).toBe(false);
    expect(isMonthlyQuotaExhaustion('quota is exhausted for this request')).toBe(false);
    expect(isMonthlyQuotaExhaustion('')).toBe(false);
    expect(isMonthlyQuotaExhaustion(null)).toBe(false);
    expect(isMonthlyQuotaExhaustion('x'.repeat(2_001))).toBe(false);
  });

  it('parses reset timestamps case-insensitively with strict UTC bounds', () => {
    const now = Date.UTC(2026, 9, 22, 18, 4, 0);
    // Exact observed token-plan phrase, lowercase and capitalized Reset.
    expect(parseProviderResetAt('The quota will reset at 11-05 16:00:00 UTC', now)).toBe(Date.UTC(2026, 10, 5, 16, 0, 0));
    expect(parseProviderResetAt('The quota will Reset at 11-05 16:00:00 UTC', now)).toBe(Date.UTC(2026, 10, 5, 16, 0, 0));
    expect(parseProviderResetAt('Quota exhausted. Reset at 2026-11-05 16:00:00 UTC', now)).toBe(Date.UTC(2026, 10, 5, 16, 0, 0));
    // Strict bounds retained: past resets and non-UTC zones never admit.
    expect(parseProviderResetAt('Reset at 2026-10-21 18:04:00 UTC', now)).toBeNull();
    expect(parseProviderResetAt('Reset at 11-05 16:00:00 PST', now)).toBeNull();
  });
});

describe('Qwen API boundary', () => {
  it('supports schema-guided JSON object output for intake without constrained decoding', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }));
    const client = new QwenApiClient({ apiKey: 'test-key', fetchImpl, structuredOutputMode: 'json_object' });
    await client.completeJson({ system: 'Draft', user: 'Input', reasoningEffort: 'medium', jsonSchema: { name: 'test', schema: { type: 'object' } } });
    const request = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(request.response_format).toEqual({ type: 'json_object' });
    expect(request.messages[0].content).toContain('"type":"object"');
  });
  it.each([
    ['length', '{"ok":true}', 'output_budget'],
    ['stop', '{"private":"do not echo this', 'invalid_json'],
  ])('rejects incomplete or malformed answers safely (%s)', async (finish_reason, content, kind) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ choices: [{ finish_reason, message: { content } }] }));
    const client = new QwenApiClient({ apiKey: 'test-key', fetchImpl });
    await expect(client.completeJson({ system: 'JSON', user: 'test', reasoningEffort: 'low' })).rejects.toMatchObject({ kind });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('allows bounded long-reasoning requests to run for five minutes by default', () => {
    expect(DEFAULT_QWEN_API_TIMEOUT_MS).toBe(5 * 60_000);
  });

  it('does not treat an unrelated OpenAI credential as a Qwen credential', () => {
    const priorDashscope = process.env.DASHSCOPE_API_KEY;
    const priorOpenAi = process.env.OPENAI_API_KEY;
    delete process.env.DASHSCOPE_API_KEY;
    process.env.OPENAI_API_KEY = 'unrelated-openai-key';
    try {
      expect(() => new QwenApiClient()).toThrow('DASHSCOPE_API_KEY');
    } finally {
      if (priorDashscope === undefined) delete process.env.DASHSCOPE_API_KEY;
      else process.env.DASHSCOPE_API_KEY = priorDashscope;
      if (priorOpenAi === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = priorOpenAi;
    }
  });

  it('retries a bounded transient failure and preserves Qwen reasoning controls', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('busy', { status: 529 }))
      .mockResolvedValueOnce(
        Response.json({
          choices: [{ message: { content: '{"ok":true}', reasoning_content: 'checked' } }],
          usage: { total_tokens: 7 },
        }),
      );
    const client = new QwenApiClient({
      apiKey: 'test-key',
      fetchImpl,
      maxAttempts: 2,
      timeoutMs: 1_000,
    });

    const result = await client.completeJson<{ ok: boolean }>({
      system: 'Return JSON.',
      user: 'Confirm.',
      reasoningEffort: 'xhigh',
    });

    expect(result.value).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const request = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(request).toMatchObject({
      model: 'qwen3.8-max',
      reasoning_effort: 'xhigh',
      enable_thinking: true,
      preserve_thinking: true,
      response_format: { type: 'json_object' },
    });
  });

  it('does not retry an authentication failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('unauthorized', { status: 401 }));
    const client = new QwenApiClient({ apiKey: 'test-key', fetchImpl, maxAttempts: 3, timeoutMs: 1_000 });
    await expect(
      client.completeJson({ system: 'Return JSON.', user: 'Confirm.', reasoningEffort: 'low' }),
    ).rejects.toThrow('HTTP 401');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('redacts credential-like provider error text before surfacing it', async () => {
    const secret = 'sk-testSecretValue1234567890';
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(`invalid credential ${secret}`, { status: 401 }),
    );
    const client = new QwenApiClient({ apiKey: 'test-key', fetchImpl, maxAttempts: 1 });
    await expect(client.completeJson({ system: 'JSON', user: 'test', reasoningEffort: 'low' }))
      .rejects.toThrow('invalid credential [REDACTED]');
  });

  it('uses strict JSON Schema output when a planning boundary supplies one', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }),
    );
    const client = new QwenApiClient({ apiKey: 'test-key', fetchImpl, timeoutMs: 1_000 });

    await client.completeJson({
      system: 'Return JSON.',
      user: 'Confirm.',
      reasoningEffort: 'low',
      jsonSchema: {
        name: 'confirmation',
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok'],
          properties: { ok: { type: 'boolean' } },
        },
      },
    });

    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(request.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'confirmation',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok'],
          properties: { ok: { type: 'boolean' } },
        },
      },
    });
  });

  it('honors an operator abort before issuing a request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const controller = new AbortController();
    controller.abort();
    const client = new QwenApiClient({ apiKey: 'test-key', fetchImpl, timeoutMs: 1_000 });
    await expect(
      client.completeJson({
        system: 'Return JSON.',
        user: 'Confirm.',
        reasoningEffort: 'low',
        signal: controller.signal,
      }),
    ).rejects.toThrow('aborted');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails fast on a confirmed 429 insufficient_quota, persists the hold, and blocks later requests without an attempt', async () => {
    const stateRoot = makeTmp('qwen-api-quota');
    const quotaHold = new ProviderQuotaHold(stateRoot);
    try {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response('{"error":{"code":"insufficient_quota","message":"Quota exhausted. Reset at 03-01 00:00:00 UTC"}}', { status: 429 }),
      );
      const client = new QwenApiClient({ apiKey: 'test-key', fetchImpl, maxAttempts: 3, timeoutMs: 1_000, quotaHold });
      const now = Date.now();
      await expect(
        client.completeJson({ system: 'Return JSON.', user: 'Confirm.', reasoningEffort: 'low' }),
      ).rejects.toMatchObject({ name: 'QuotaHoldActiveError' });
      // Confirmed quota exhaustion never retries.
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const heldUntil = quotaHold.heldUntil({ baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-max', credentialEnvKey: 'DASHSCOPE_API_KEY' }, now);
      expect(heldUntil).not.toBeNull();
      // The persisted hold survives restart and blocks the next request before fetch.
      quotaHold.close();
      const reopened = new ProviderQuotaHold(stateRoot);
      try {
        const blocked = new QwenApiClient({ apiKey: 'test-key', fetchImpl, timeoutMs: 1_000, quotaHold: reopened });
        await expect(
          blocked.completeJson({ system: 'Return JSON.', user: 'Confirm.', reasoningEffort: 'low' }),
        ).rejects.toMatchObject({ name: 'QuotaHoldActiveError', heldUntil });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      } finally { reopened.close(); }
    } finally {
      // close is idempotent enough for the finally path when already closed.
    }
  });

  it('defaults to the shared durable hold on the real fetch boundary and closes its store', async () => {
    const stateRoot = makeTmp('qwen-api-default-hold-root');
    const priorStateDir = process.env.QWEN_HARNESS_STATE_DIR;
    process.env.QWEN_HARNESS_STATE_DIR = stateRoot;
    try {
      const route = { baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-max', credentialEnvKey: 'DASHSCOPE_API_KEY' };
      const seeder = new ProviderQuotaHold(stateRoot);
      const heldUntil = seeder.applyHold(route, { kind: 'insufficient_quota', now: Date.now() });
      seeder.close();
      // No quotaHold injected and no injected fetchImpl: the real-network
      // boundary must enforce the shared durable hold before any fetch.
      const client = new QwenApiClient({ apiKey: 'test-key', maxAttempts: 1, timeoutMs: 1_000 });
      await expect(
        client.completeJson({ system: 'Return JSON.', user: 'Confirm.', reasoningEffort: 'low' }),
      ).rejects.toMatchObject({ name: 'QuotaHoldActiveError', heldUntil });
    } finally {
      if (priorStateDir === undefined) delete process.env.QWEN_HARNESS_STATE_DIR;
      else process.env.QWEN_HARNESS_STATE_DIR = priorStateDir;
    }
  });

  it('retries a non-quota 429 without applying any hold', async () => {
    const stateRoot = makeTmp('qwen-api-rate-limit');
    const quotaHold = new ProviderQuotaHold(stateRoot);
    try {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('rate limit exceeded', { status: 429, headers: { 'retry-after': '0' } }))
        .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }));
      const client = new QwenApiClient({ apiKey: 'test-key', fetchImpl, maxAttempts: 2, timeoutMs: 1_000, quotaHold });
      const result = await client.completeJson<{ ok: boolean }>({ system: 'Return JSON.', user: 'Confirm.', reasoningEffort: 'low' });
      expect(result.value).toEqual({ ok: true });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(quotaHold.inspect()).toHaveLength(0);
    } finally { quotaHold.close(); }
  });
});

describe('Qwen API usage ledger integration', () => {
  const complete = (client: QwenApiClient, signal?: AbortSignal) =>
    client.completeJson({ system: 'Return JSON.', user: 'Confirm.', reasoningEffort: 'low', signal });

  it('records one metered direct call per successful completeJson invocation', async () => {
    const ledger = new UsageLedger('api-usage-ok', makeTmp('api-usage-ok'));
    try {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
        Response.json({ choices: [{ message: { content: '{"ok":true}' } }], usage: { total_tokens: 42 } }),
      );
      const client = new QwenApiClient({ apiKey: 'test-key', fetchImpl, usageLedger: ledger });
      await complete(client);
      await complete(client);
      // Two invocations, two fresh opaque call ids: both counted, neither doubled.
      expect(ledger.summary()).toMatchObject({ directCallCount: 2, observedTotalTokens: 84, unmeteredCount: 0 });
    } finally { ledger.close(); }
  });

  it.each([
    ['length', '{"ok":true}', 'output_budget'],
    ['stop', '{"private":"do not echo this', 'invalid_json'],
  ])('counts a completed HTTP 200 before validating the answer (%s)', async (finish_reason, content, kind) => {
    const ledger = new UsageLedger('api-usage-malformed', makeTmp('api-usage-malformed'));
    try {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({ choices: [{ finish_reason, message: { content } }], usage: { total_tokens: 7 } }),
      );
      const client = new QwenApiClient({ apiKey: 'test-key', fetchImpl, usageLedger: ledger });
      await expect(complete(client)).rejects.toMatchObject({ kind });
      // The rejected call still consumed tokens: recorded before validation.
      expect(ledger.summary()).toMatchObject({ directCallCount: 1, observedTotalTokens: 7, unmeteredCount: 0 });
    } finally { ledger.close(); }
  });

  it('counts a retried invocation exactly once when a retry succeeds', async () => {
    const ledger = new UsageLedger('api-usage-retry', makeTmp('api-usage-retry'));
    try {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('rate limit exceeded', { status: 429, headers: { 'retry-after': '0' } }))
        .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: '{"ok":true}' } }], usage: { total_tokens: 11 } }));
      const client = new QwenApiClient({ apiKey: 'test-key', fetchImpl, maxAttempts: 2, timeoutMs: 1_000, usageLedger: ledger });
      await expect(complete(client)).resolves.toMatchObject({ value: { ok: true } });
      // The 429 produced no completed call; the succeeded retry shares the
      // invocation's single call id and cannot double count it.
      expect(ledger.summary()).toMatchObject({ directCallCount: 1, observedTotalTokens: 11, unmeteredCount: 0 });
    } finally { ledger.close(); }
  });

  it('never records a 429-only invocation as a zero-token call', async () => {
    const ledger = new UsageLedger('api-usage-429', makeTmp('api-usage-429'));
    try {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => new Response('rate limit exceeded', { status: 429, headers: { 'retry-after': '0' } }));
      const client = new QwenApiClient({ apiKey: 'test-key', fetchImpl, maxAttempts: 2, timeoutMs: 1_000, usageLedger: ledger });
      await expect(complete(client)).rejects.toThrow('HTTP 429');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const summary = ledger.summary();
      expect(summary.directCallCount).toBe(0);
      expect(summary.observedTotalTokens).toBe(0);
      expect(summary.unmeteredCount).toBe(0);
    } finally { ledger.close(); }
  });

  it('marks a completed 200 with missing usage as unmetered, never zero', async () => {
    const ledger = new UsageLedger('api-usage-missing', makeTmp('api-usage-missing'));
    try {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }),
      );
      const client = new QwenApiClient({ apiKey: 'test-key', fetchImpl, usageLedger: ledger });
      await expect(complete(client)).resolves.toMatchObject({ value: { ok: true } });
      expect(ledger.summary()).toMatchObject({ directCallCount: 0, observedTotalTokens: 0, unmeteredCount: 1 });
    } finally { ledger.close(); }
  });

  it('persists direct-call usage across a ledger restart', async () => {
    const stateDir = makeTmp('api-usage-restart');
    const first = new UsageLedger('api-usage-restart', stateDir);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ choices: [{ message: { content: '{"ok":true}' } }], usage: { total_tokens: 19 } }),
    );
    try {
      await complete(new QwenApiClient({ apiKey: 'test-key', fetchImpl, usageLedger: first }));
      expect(first.summary()).toMatchObject({ directCallCount: 1, observedTotalTokens: 19 });
    } finally { first.close(); }
    const reopened = new UsageLedger('api-usage-restart', stateDir);
    try {
      expect(reopened.summary()).toMatchObject({ directCallCount: 1, observedTotalTokens: 19, unmeteredCount: 0 });
    } finally { reopened.close(); }
  });
});

describe('Qwen API observed-token budget boundary', () => {
  const complete = (client: QwenApiClient) =>
    client.completeJson({ system: 'Return JSON.', user: 'Confirm.', reasoningEffort: 'low' });

  it.each([
    ['limit-reached', 100, 'call-1', { total_tokens: 100 }],
    ['unmetered-observation', 1_000, 'call-1', undefined],
  ] as const)('blocks the request before any fetch once the budget blocks (%s)', async (reason, limit, callId, usage) => {
    const ledger = new UsageLedger(`api-budget-${reason}`, makeTmp(`api-budget-${reason}`));
    try {
      ledger.recordDirectApiUsage(callId, usage);
      const budget = new ObservedTokenBudget(limit, ledger);
      const fetchImpl = vi.fn<typeof fetch>();
      const client = new QwenApiClient({ apiKey: 'test-key', fetchImpl, maxAttempts: 3, timeoutMs: 1_000, usageBudget: budget });
      await expect(complete(client)).rejects.toMatchObject({ name: 'UsageBudgetActiveError' });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally { ledger.close(); }
  });

  it('keeps the budget off (no blocking) when no limit is configured', async () => {
    const ledger = new UsageLedger('api-budget-disabled', makeTmp('api-budget-disabled'));
    try {
      ledger.recordDirectApiUsage('call-1', { total_tokens: 5_000 });
      const budget = new ObservedTokenBudget(null, ledger);
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({ choices: [{ message: { content: '{"ok":true}' } }], usage: { total_tokens: 7 } }),
      );
      const client = new QwenApiClient({ apiKey: 'test-key', fetchImpl, usageBudget: budget });
      await expect(complete(client)).resolves.toMatchObject({ value: { ok: true } });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally { ledger.close(); }
  });
});
