import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectConfig } from '../core/types.js';
import { harnessStateRoot } from '../core/state-paths.js';

export type QwenCredentialSource = 'process environment' | 'worker environment' | 'Qwen user settings' | 'Qwen user .env';

export interface ResolvedQwenCredential {
  apiKey: string;
  envKey: string;
  source: QwenCredentialSource;
}

export function qwenCredentialCompatibilityProblem(
  config: Pick<ProjectConfig, 'qwen'>,
  credential: ResolvedQwenCredential,
): string | null {
  const planKey = credential.apiKey.startsWith('sk-sp-');
  if (config.qwen.billingPlan === 'standard' && planKey) {
    return 'A plan-specific sk-sp credential is paired with the standard QwenCloud endpoint. Token Plan, Coding Plan, and pay-as-you-go keys/endpoints are not interchangeable. Token Plan Personal also prohibits this unattended harness; use Token Plan Team or pay-as-you-go.';
  }
  if (config.qwen.billingPlan === 'token-plan-team' && !planKey) {
    return 'Token Plan Team requires its dedicated sk-sp credential and Token Plan endpoint.';
  }
  return null;
}

export function assertQwenCredentialCompatibility(
  config: Pick<ProjectConfig, 'qwen'>,
  credential: ResolvedQwenCredential,
): void {
  const problem = qwenCredentialCompatibilityProblem(config, credential);
  if (problem) throw new Error(problem);
}

export function detectQwenCredentialEnvKey(
  options: {
    environment?: NodeJS.ProcessEnv;
    qwenSettingsFile?: string;
    qwenEnvironmentFile?: string;
  } = {},
): string {
  const environment = options.environment ?? process.env;
  const qwenHome = path.join(os.homedir(), '.qwen');
  const settingsFile = options.qwenSettingsFile ?? path.join(qwenHome, 'settings.json');
  const environmentFile = options.qwenEnvironmentFile ?? path.join(qwenHome, '.env');
  for (const envKey of ['BAILIAN_TOKEN_PLAN_API_KEY', 'BAILIAN_API_KEY', 'DASHSCOPE_API_KEY', 'BAILIAN_CODING_PLAN_API_KEY']) {
    if (environment[envKey] || readQwenSettingsValue(settingsFile, envKey) || readDotEnvValue(environmentFile, envKey)) {
      return envKey;
    }
  }
  return 'DASHSCOPE_API_KEY';
}

/** Resolve the configured Qwen credential without copying it into tracked project files. */
export function resolveQwenCredential(
  config: Pick<ProjectConfig, 'qwen'>,
  options: {
    environment?: NodeJS.ProcessEnv;
    workerEnvironmentFile?: string;
    qwenSettingsFile?: string;
    qwenEnvironmentFile?: string;
  } = {},
): ResolvedQwenCredential | null {
  const envKey = config.qwen.credentialEnvKey;
  const environment = options.environment ?? process.env;
  const processValue = environment[envKey];
  if (processValue) return { apiKey: processValue, envKey, source: 'process environment' };

  const workerValue = readEnvironmentFileValue(
    options.workerEnvironmentFile ?? path.join(harnessStateRoot(), 'worker.env'),
    envKey,
  );
  if (workerValue) return { apiKey: workerValue, envKey, source: 'worker environment' };

  const qwenHome = path.join(os.homedir(), '.qwen');
  const settingsValue = readQwenSettingsValue(
    options.qwenSettingsFile ?? path.join(qwenHome, 'settings.json'),
    envKey,
  );
  if (settingsValue) return { apiKey: settingsValue, envKey, source: 'Qwen user settings' };

  const qwenEnvValue = readDotEnvValue(
    options.qwenEnvironmentFile ?? path.join(qwenHome, '.env'),
    envKey,
  );
  if (qwenEnvValue) return { apiKey: qwenEnvValue, envKey, source: 'Qwen user .env' };
  return null;
}

export function readQwenSettingsValue(file: string, envKey: string): string | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const settings = JSON.parse(readFileSync(file, 'utf8')) as { env?: Record<string, unknown> };
    const value = settings.env?.[envKey];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function readEnvironmentFileValue(file: string, name: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .find((candidate) => candidate.startsWith(`${name}=`));
  if (!line) return undefined;
  const raw = line.slice(name.length + 1).trim();
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    return stripMatchingQuotes(raw) || undefined;
  }
}

function readDotEnvValue(file: string, name: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const assignment = readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => !line.startsWith('#') && new RegExp(`^(?:export\\s+)?${name}\\s*=`).test(line));
  if (!assignment) return undefined;
  const raw = assignment.slice(assignment.indexOf('=') + 1).trim();
  return stripMatchingQuotes(raw) || undefined;
}

function stripMatchingQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
