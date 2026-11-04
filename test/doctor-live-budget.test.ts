import { describe, expect, it, vi } from 'vitest';
import { defaultProjectConfig } from '../src/core/config.js';
import { doctorLiveMaxTokens } from '../src/doctor.js';
import { QwenApiClient } from '../src/qwen/qwen-api.js';
import {
  OPENROUTER_CROUTON_BASE_URL,
  OPENROUTER_CROUTON_BILLING_PLAN,
  OPENROUTER_CROUTON_CREDENTIAL_ENV_KEY,
  OPENROUTER_CROUTON_MODEL,
} from '../src/qwen/openrouter-route.js';
import { makeTmp } from './helpers.js';

function croutonConfig() {
  const config = defaultProjectConfig(makeTmp('doctor-live-crouton'));
  config.qwen = {
    ...config.qwen,
    model: OPENROUTER_CROUTON_MODEL,
    baseUrl: OPENROUTER_CROUTON_BASE_URL,
    credentialEnvKey: OPENROUTER_CROUTON_CREDENTIAL_ENV_KEY,
    billingPlan: OPENROUTER_CROUTON_BILLING_PLAN,
  };
  return config;
}

describe('doctor live probe output budget', () => {
  it('keeps the Qwen direct route at the current 32-token budget', () => {
    const config = defaultProjectConfig(makeTmp('doctor-live-qwen'));
    expect(doctorLiveMaxTokens(config)).toBe(32);
  });

  it('uses the 1024-token budget only for the exact crouton route', () => {
    expect(doctorLiveMaxTokens(croutonConfig())).toBe(1024);
    // A partial or mismatched route never earns the larger budget.
    const mismatched = croutonConfig();
    mismatched.qwen = { ...mismatched.qwen, baseUrl: 'https://api.openai.com/v1' };
    expect(doctorLiveMaxTokens(mismatched)).toBe(32);
  });

  it('sends the route-specific budget on the mocked API wire without Qwen-only fields', async () => {
    const config = croutonConfig();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }),
    );
    const client = new QwenApiClient({
      apiKey: 'test-key',
      model: config.qwen.model,
      baseUrl: config.qwen.baseUrl,
      credentialEnvKey: config.qwen.credentialEnvKey,
      billingPlan: config.qwen.billingPlan,
      fetchImpl,
    });
    const result = await client.completeJson<{ ok: boolean }>({
      system: 'Return JSON only.',
      user: 'Return {"ok":true}.',
      reasoningEffort: 'low',
      maxTokens: doctorLiveMaxTokens(config),
    });
    expect(result.value).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(`${OPENROUTER_CROUTON_BASE_URL}/chat/completions`);
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(request.max_tokens).toBe(1024);
    expect(request.model).toBe(OPENROUTER_CROUTON_MODEL);
    expect(request.enable_thinking).toBeUndefined();
    expect(request.preserve_thinking).toBeUndefined();
  });
});
