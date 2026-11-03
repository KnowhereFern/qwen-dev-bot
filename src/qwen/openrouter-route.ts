import type { QwenBillingPlan } from '../core/types.js';

/**
 * Explicit alternate execution route: the OpenRouter model stealth/crouton-alpha
 * (https://openrouter.ai/stealth/crouton-alpha). This route is opt-in only; the
 * default Qwen3.8 route remains unchanged. Pure helpers only — no executor here.
 */
export const OPENROUTER_CROUTON_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_CROUTON_MODEL = 'stealth/crouton-alpha';
export const OPENROUTER_CROUTON_CREDENTIAL_ENV_KEY = 'OPENROUTER_API_KEY';
export const OPENROUTER_CROUTON_BILLING_PLAN: QwenBillingPlan = 'custom';

/** Fields the Qwen-only direct API body uses that the OpenRouter model must never receive. */
const QWEN_ONLY_BODY_FIELDS = ['enable_thinking', 'preserve_thinking'] as const;

export interface ProviderRouteLike {
  model: string;
  baseUrl: string;
  credentialEnvKey?: string;
  billingPlan?: QwenBillingPlan;
}

/**
 * Return a rejection reason when the route is not the exact allowed
 * stealth/crouton-alpha route, or null when it is. Model, endpoint, credential
 * key, and billing plan must each match exactly.
 */
export function openRouterCroutonRouteProblem(route: ProviderRouteLike): string | null {
  if (route.model !== OPENROUTER_CROUTON_MODEL) {
    return `Crouton route requires model ${OPENROUTER_CROUTON_MODEL}; got ${route.model}`;
  }
  const normalizedBaseUrl = route.baseUrl.replace(/\/+$/, '');
  if (normalizedBaseUrl !== OPENROUTER_CROUTON_BASE_URL) {
    return `Crouton route requires endpoint ${OPENROUTER_CROUTON_BASE_URL}; got ${route.baseUrl}`;
  }
  if (route.credentialEnvKey !== undefined && route.credentialEnvKey !== OPENROUTER_CROUTON_CREDENTIAL_ENV_KEY) {
    return `Crouton route requires credential key ${OPENROUTER_CROUTON_CREDENTIAL_ENV_KEY}; got ${route.credentialEnvKey}`;
  }
  if (route.billingPlan !== undefined && route.billingPlan !== OPENROUTER_CROUTON_BILLING_PLAN) {
    return `Crouton route requires billingPlan ${OPENROUTER_CROUTON_BILLING_PLAN}; got ${route.billingPlan}`;
  }
  return null;
}

/** True only for the exact allowed stealth/crouton-alpha route. */
export function isOpenRouterCroutonRoute(route: ProviderRouteLike): boolean {
  return openRouterCroutonRouteProblem(route) === null;
}

/** Throw unless the route is the exact allowed stealth/crouton-alpha route. */
export function assertOpenRouterCroutonRoute(route: ProviderRouteLike): void {
  const problem = openRouterCroutonRouteProblem(route);
  if (problem) throw new Error(problem);
}

/**
 * Qwen Code CLI auth selector arguments for the Crouton route. The credential
 * itself is never placed in arguments: it reaches the child only through the
 * environment mapping below, so it cannot appear in process listings or logs.
 */
export function openRouterCroutonCliArgs(): string[] {
  return ['--auth-type', 'openai'];
}

const MINIMAL_CROUTON_ENVIRONMENT = [
  'PATH',
  'Path',
  'PATHEXT',
  'SYSTEMROOT',
  'SystemRoot',
  'COMSPEC',
  'HOME',
  'USERPROFILE',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'COLORTERM',
  'CI',
  'NO_COLOR',
  'FORCE_COLOR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
] as const;

/**
 * Credential-minimized child environment for the Crouton route. Only runtime
 * essentials plus the OpenRouter key are inherited — DashScope/Bailian keys and
 * every other ambient secret are excluded. Throws when the key is absent so a
 * child can never start silently unauthenticated against the wrong provider.
 */
export function openRouterCroutonChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const apiKey = source[OPENROUTER_CROUTON_CREDENTIAL_ENV_KEY];
  if (!apiKey) throw new Error(`Crouton route requires ${OPENROUTER_CROUTON_CREDENTIAL_ENV_KEY} in the parent environment`);
  const environment = Object.fromEntries(
    MINIMAL_CROUTON_ENVIRONMENT.flatMap((name) =>
      source[name] === undefined ? [] : [[name, source[name]]],
    ),
  );
  environment.OPENAI_API_KEY = apiKey;
  // Pin the OpenAI-compatible client inside Qwen Code to the OpenRouter endpoint.
  environment.OPENAI_BASE_URL = OPENROUTER_CROUTON_BASE_URL;
  // Match the default Qwen child env: session storage stays encrypted on this
  // route too, regardless of ambient settings.
  environment.QWEN_CODE_FORCE_ENCRYPTED_FILE_STORAGE = 'true';
  return environment;
}

/**
 * Provider-specific direct API body fields for the Crouton route. Drops the
 * Qwen-only enable_thinking/preserve_thinking flags while preserving standard
 * reasoning_effort and response_format, and pins the model to
 * stealth/crouton-alpha. No provider routing overrides are injected.
 */
export function openRouterCroutonRequestBody(
  base: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    if ((QWEN_ONLY_BODY_FIELDS as readonly string[]).includes(key)) continue;
    body[key] = value;
  }
  body.model = OPENROUTER_CROUTON_MODEL;
  return body;
}
