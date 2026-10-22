import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultProjectConfig } from '../core/config.js';
import type { ProjectConfig } from '../core/types.js';
import { QWEN_HARNESS_MODEL, TOKEN_PLAN_QWEN_BASE_URL } from '../qwen/runtime-compat.js';

/** Match the saved model AND endpoint; duplicate model IDs must not select a different billing route. */
export function intakeConnection(root: string, settingsFile = path.join(os.homedir(), '.qwen', 'settings.json')): ProjectConfig {
  let saved: { model?: { name?: string; baseUrl?: string }; modelProviders?: { openai?: Array<{ id: string; baseUrl: string; envKey: string }> } };
  try { saved = JSON.parse(readFileSync(settingsFile, 'utf8')); }
  catch { throw new Error('Configure your Qwen model connection first, then retry spec intake. No credentials were changed.'); }
  if (saved.model?.name !== QWEN_HARNESS_MODEL || !saved.model.baseUrl) throw new Error('Spec intake needs a saved qwen3.8-max model and endpoint pair');
  const matches = saved.modelProviders?.openai?.filter((entry) => entry.id === saved.model!.name && entry.baseUrl.replace(/\/+$/, '') === saved.model!.baseUrl!.replace(/\/+$/, '')) ?? [];
  if (matches.length !== 1 || !/^[A-Z_][A-Z0-9_]*$/.test(matches[0].envKey)) throw new Error('Saved Qwen connection is ambiguous or lacks its credential variable; configure the exact model/endpoint pair');
  const config = defaultProjectConfig(root);
  config.qwen.baseUrl = matches[0].baseUrl;
  config.qwen.credentialEnvKey = matches[0].envKey;
  config.qwen.billingPlan = matches[0].baseUrl.replace(/\/+$/, '') === TOKEN_PLAN_QWEN_BASE_URL ? 'token-plan-personal' : 'standard';
  return config;
}
