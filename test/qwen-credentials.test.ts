import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultProjectConfig } from '../src/core/config.js';
import { qwenCredentialCompatibilityProblem, resolveQwenCredential } from '../src/qwen/credential-resolver.js';
import { makeTmp } from './helpers.js';

describe('Qwen credential resolution', () => {
  it('reuses the credential already saved by Qwen Code without exposing its value', () => {
    const root = makeTmp('qwen-credential');
    const settings = path.join(root, 'settings.json');
    const worker = path.join(root, 'missing-worker.env');
    const qwenEnv = path.join(root, 'missing-qwen.env');
    writeFileSync(settings, JSON.stringify({ env: { DASHSCOPE_API_KEY: 'saved-secret' } }));
    const config = defaultProjectConfig(root, 'fixture', 'owner/fixture');

    const credential = resolveQwenCredential(config, {
      environment: {},
      workerEnvironmentFile: worker,
      qwenSettingsFile: settings,
      qwenEnvironmentFile: qwenEnv,
    });

    expect(credential).toEqual({
      apiKey: 'saved-secret',
      envKey: 'DASHSCOPE_API_KEY',
      source: 'Qwen user settings',
    });
    expect(`${credential?.source} ${credential?.envKey}`).not.toContain('saved-secret');
  });

  it('rejects a plan key routed through the standard billing endpoint', () => {
    const config = defaultProjectConfig(makeTmp('qwen-route'), 'fixture', 'owner/fixture');
    expect(
      qwenCredentialCompatibilityProblem(config, {
        apiKey: 'sk-sp-redacted',
        envKey: 'DASHSCOPE_API_KEY',
        source: 'Qwen user settings',
      }),
    ).toMatch(/not interchangeable/);
  });

  it.each(['token-plan-personal', 'token-plan-team'] as const)('requires an sk-sp credential for %s', (billingPlan) => {
    const config = defaultProjectConfig(makeTmp(`qwen-${billingPlan}`), 'fixture', 'owner/fixture');
    config.qwen.billingPlan = billingPlan;
    config.qwen.baseUrl = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
    expect(
      qwenCredentialCompatibilityProblem(config, {
        apiKey: 'standard-redacted',
        envKey: 'BAILIAN_TOKEN_PLAN_API_KEY',
        source: 'Qwen user settings',
      }),
    ).toMatch(/dedicated sk-sp credential/);
  });
});
