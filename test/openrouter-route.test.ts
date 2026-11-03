import { describe, expect, it } from 'vitest';
import {
  OPENROUTER_CROUTON_BASE_URL,
  OPENROUTER_CROUTON_CREDENTIAL_ENV_KEY,
  OPENROUTER_CROUTON_MODEL,
  assertOpenRouterCroutonRoute,
  isOpenRouterCroutonRoute,
  openRouterCroutonChildEnvironment,
  openRouterCroutonCliArgs,
  openRouterCroutonRequestBody,
  openRouterCroutonRouteProblem,
} from '../src/qwen/openrouter-route.js';

const VALID_ROUTE = {
  model: OPENROUTER_CROUTON_MODEL,
  baseUrl: OPENROUTER_CROUTON_BASE_URL,
  credentialEnvKey: OPENROUTER_CROUTON_CREDENTIAL_ENV_KEY,
  billingPlan: 'custom' as const,
};

describe('OpenRouter Crouton route recognition', () => {
  it('requires exactly the stealth/crouton-alpha model', () => {
    expect(OPENROUTER_CROUTON_MODEL).toBe('stealth/crouton-alpha');
  });

  it('accepts the exact allowed route', () => {
    expect(isOpenRouterCroutonRoute(VALID_ROUTE)).toBe(true);
    expect(openRouterCroutonRouteProblem(VALID_ROUTE)).toBeNull();
    expect(() => assertOpenRouterCroutonRoute(VALID_ROUTE)).not.toThrow();
  });

  it('tolerates trailing slashes on the endpoint', () => {
    expect(isOpenRouterCroutonRoute({ ...VALID_ROUTE, baseUrl: `${OPENROUTER_CROUTON_BASE_URL}/` })).toBe(true);
  });

  it('rejects a mismatched model', () => {
    const problem = openRouterCroutonRouteProblem({ ...VALID_ROUTE, model: 'z-ai/glm-5.3' });
    expect(problem).toContain('requires model stealth/crouton-alpha');
    expect(isOpenRouterCroutonRoute({ ...VALID_ROUTE, model: 'z-ai/glm-5.3:crouton-alpha' })).toBe(false);
    expect(isOpenRouterCroutonRoute({ ...VALID_ROUTE, model: 'stealth/crouton-alpha:crouton-alpha' })).toBe(false);
  });

  it('rejects endpoint variations', () => {
    expect(isOpenRouterCroutonRoute({ ...VALID_ROUTE, baseUrl: 'https://openrouter.ai/api/v2' })).toBe(false);
    expect(isOpenRouterCroutonRoute({ ...VALID_ROUTE, baseUrl: 'https://api.openrouter.ai/api/v1' })).toBe(false);
    expect(isOpenRouterCroutonRoute({ ...VALID_ROUTE, baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' })).toBe(false);
  });

  it('rejects a mismatched credential key or billing plan', () => {
    expect(isOpenRouterCroutonRoute({ ...VALID_ROUTE, credentialEnvKey: 'DASHSCOPE_API_KEY' })).toBe(false);
    expect(isOpenRouterCroutonRoute({ ...VALID_ROUTE, billingPlan: 'standard' as const })).toBe(false);
    expect(() => assertOpenRouterCroutonRoute({ ...VALID_ROUTE, billingPlan: 'token-plan-personal' as const })).toThrow(/billingPlan/);
  });
});

describe('OpenRouter Crouton CLI args and child environment', () => {
  it('selects OpenAI-compatible auth without any credential material in arguments', () => {
    const args = openRouterCroutonCliArgs();
    expect(args).toEqual(['--auth-type', 'openai']);
    expect(args.join(' ')).not.toContain('sk-');
  });

  it('passes only runtime essentials plus the OpenRouter key via the OpenAI-compatible env', () => {
    const environment = openRouterCroutonChildEnvironment({
      PATH: '/bin',
      HOME: '/safe-home',
      OPENROUTER_API_KEY: 'openrouter-secret',
      DASHSCOPE_API_KEY: 'dashscope-secret',
      BAILIAN_API_KEY: 'bailian-secret',
      GH_TOKEN: 'github-secret',
      NODE_OPTIONS: '--require=/tmp/inject.cjs',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
    });
    expect(environment).toMatchObject({
      PATH: '/bin',
      HOME: '/safe-home',
      OPENAI_API_KEY: 'openrouter-secret',
      OPENAI_BASE_URL: OPENROUTER_CROUTON_BASE_URL,
      QWEN_CODE_FORCE_ENCRYPTED_FILE_STORAGE: 'true',
    });
    // Encrypted file storage is pinned, not inherited: a hostile parent value
    // cannot disable it.
    expect(
      openRouterCroutonChildEnvironment({
        OPENROUTER_API_KEY: 'openrouter-secret',
        QWEN_CODE_FORCE_ENCRYPTED_FILE_STORAGE: 'false',
      }).QWEN_CODE_FORCE_ENCRYPTED_FILE_STORAGE,
    ).toBe('true');
    expect(environment).not.toHaveProperty('OPENROUTER_API_KEY');
    expect(environment).not.toHaveProperty('DASHSCOPE_API_KEY');
    expect(environment).not.toHaveProperty('BAILIAN_API_KEY');
    expect(environment).not.toHaveProperty('GH_TOKEN');
    expect(environment).not.toHaveProperty('NODE_OPTIONS');
    expect(environment).not.toHaveProperty('SSH_AUTH_SOCK');
  });

  it('throws when the OpenRouter key is absent', () => {
    expect(() => openRouterCroutonChildEnvironment({ PATH: '/bin' })).toThrow(OPENROUTER_CROUTON_CREDENTIAL_ENV_KEY);
  });
});

describe('OpenRouter Crouton direct API body fields', () => {
  it('drops Qwen-only thinking flags and preserves standard fields without provider overrides', () => {
    const body = openRouterCroutonRequestBody({
      model: 'qwen3.8-max',
      enable_thinking: true,
      preserve_thinking: true,
      reasoning_effort: 'low',
      temperature: 0,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
    });
    expect(body).not.toHaveProperty('enable_thinking');
    expect(body).not.toHaveProperty('preserve_thinking');
    expect(body).not.toHaveProperty('provider');
    expect(body).toMatchObject({
      reasoning_effort: 'low',
      temperature: 0,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
      model: OPENROUTER_CROUTON_MODEL,
    });
  });

  it('preserves structured json_schema response_format', () => {
    const responseFormat = { type: 'json_schema', json_schema: { name: 'answer', strict: true } };
    expect(openRouterCroutonRequestBody({ response_format: responseFormat }).response_format).toEqual(responseFormat);
  });

  it('never injects the credential into the body', () => {
    const body = openRouterCroutonRequestBody({ model: 'x', enable_thinking: true });
    expect(JSON.stringify(body)).not.toContain('sk-');
    expect(body).not.toHaveProperty('api_key');
    expect(body).not.toHaveProperty('authorization');
  });
});
