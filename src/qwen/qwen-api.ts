import { randomUUID } from 'node:crypto';
import type { ReasoningEffort, StructuredOutputSchema } from '../core/types.js';
import { redactText } from '../core/ledger.js';
import { UsageBudgetActiveError, type UsageBudgetController, type UsageLedger } from '../core/usage-ledger.js';
import { harnessStateRoot } from '../core/state-paths.js';
import { DEFAULT_QWEN_BASE_URL, QWEN_HARNESS_MODEL } from './runtime-compat.js';
import { isMonthlyQuotaExhaustion, parseProviderResetAt } from './provider-reset.js';
import {
  ProviderQuotaHold,
  providerRouteKey,
  QuotaHoldActiveError,
  type ProviderRoute,
  type QuotaHoldController,
} from './quota-hold.js';

export const DEFAULT_QWEN_API_TIMEOUT_MS = 5 * 60_000;

export interface QwenApiOptions {
  apiKey?: string;
  credentialEnvKey?: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  structuredOutputMode?: 'json_schema' | 'json_object';
  quotaHold?: QuotaHoldController;
  usageLedger?: UsageLedger;
  usageBudget?: UsageBudgetController;
}

interface ChatResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string;
      reasoning_content?: string;
    };
  }>;
  usage?: Record<string, unknown>;
}

export class QwenOutputError extends Error {
  constructor(readonly kind: 'output_budget' | 'invalid_json') {
    super(kind === 'output_budget' ? 'Qwen answer exceeded its output budget; no partial answer accepted' : 'Qwen answer was malformed JSON; no answer content logged');
    this.name = 'QwenOutputError';
  }
}

export class QwenApiClient {
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly structuredOutputMode: 'json_schema' | 'json_object';
  private readonly quotaHold?: QuotaHoldController;
  private readonly usageLedger?: UsageLedger;
  private readonly usageBudget?: UsageBudgetController;
  private readonly usesInjectedFetch: boolean;
  private readonly route: ProviderRoute;

  constructor(options: QwenApiOptions = {}) {
    const credentialEnvKey = options.credentialEnvKey ?? 'DASHSCOPE_API_KEY';
    const key = options.apiKey ?? process.env[credentialEnvKey];
    if (!key) throw new Error(`Qwen API key is required in ${credentialEnvKey} or Qwen user settings`);
    this.apiKey = key;
    this.baseUrl = (
      options.baseUrl ??
      process.env.DASHSCOPE_BASE_URL ??
      DEFAULT_QWEN_BASE_URL
    ).replace(/\/+$/, '');
    const endpoint = new URL(this.baseUrl);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
      throw new Error('Qwen API baseUrl must be HTTPS and must not embed credentials');
    }
    this.model = options.model ?? QWEN_HARNESS_MODEL;
    if (this.model !== QWEN_HARNESS_MODEL) throw new Error(`Delivery harness model must be ${QWEN_HARNESS_MODEL}`);
    this.usesInjectedFetch = options.fetchImpl !== undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_QWEN_API_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.structuredOutputMode = options.structuredOutputMode ?? 'json_schema';
    this.quotaHold = options.quotaHold;
    this.usageLedger = options.usageLedger;
    this.usageBudget = options.usageBudget;
    this.route = { baseUrl: this.baseUrl, model: this.model, credentialEnvKey };
    // Fail fast on a route key that cannot be sanitized safely.
    providerRouteKey(this.route);
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('Qwen API timeoutMs must be positive');
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts <= 0) throw new Error('Qwen API maxAttempts must be positive');
  }

  async completeJson<T>(input: {
    system: string;
    user: string | Array<Record<string, unknown>>;
    reasoningEffort: ReasoningEffort;
    maxTokens?: number;
    jsonSchema?: StructuredOutputSchema;
    signal?: AbortSignal;
  }): Promise<{ value: T; raw: string; reasoning: string; usage: Record<string, unknown> }> {
    const maxTokens = input.maxTokens ?? 4_096;
    if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) throw new Error('Qwen API maxTokens must be a positive integer');
    // One opaque call id per invocation: every completed HTTP 200 response in
    // this invocation is recorded against it, and duplicate recordings of the
    // same id (retries, replays) count exactly once in the usage ledger.
    const callId = randomUUID();
    const request = {
      model: this.model,
      messages: [
        { role: 'system', content: input.system + (input.jsonSchema && this.structuredOutputMode === 'json_object' ? `\nReturn JSON conforming to this schema:\n${JSON.stringify(input.jsonSchema.schema)}` : '') },
        { role: 'user', content: input.user },
      ],
      reasoning_effort: input.reasoningEffort,
      max_tokens: maxTokens,
      temperature: 0,
      enable_thinking: true,
      preserve_thinking: true,
      response_format: input.jsonSchema && this.structuredOutputMode === 'json_schema'
        ? { type: 'json_schema', json_schema: { ...input.jsonSchema, strict: true } }
        : { type: 'json_object' },
    };
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      if (input.signal?.aborted) throw new Error('Qwen API request aborted');
      // A durable provider-wide quota hold blocks every direct request and
      // retry on this route: fail fast before any network attempt.
      const heldUntil = this.currentHoldUntil();
      if (heldUntil !== null && heldUntil !== undefined) throw new QuotaHoldActiveError(heldUntil);
      // A configured observed-token budget blocks every direct request and
      // retry on this project: fail closed before any network attempt.
      const budget = this.usageBudget?.status();
      if (budget?.blocked) throw new UsageBudgetActiveError(budget);
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(request),
          signal: input.signal
            ? AbortSignal.any([input.signal, AbortSignal.timeout(this.timeoutMs)])
            : AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (input.signal?.aborted) throw new Error('Qwen API request aborted');
        if (attempt === this.maxAttempts) {
          throw new Error(`Qwen API request failed after ${attempt} attempt(s): ${redactText(error instanceof Error ? error.message : String(error))}`);
        }
        await delay(250 * 2 ** (attempt - 1), input.signal);
        continue;
      }
      if (!response.ok) {
        const body = (await readBoundedResponse(response, 2 * 1024 * 1024)).slice(0, 2_000);
        // Confirmed monthly quota exhaustion: persist the durable hold
        // (using a strict reset timestamp when the provider supplied one)
        // and never retry this route.
        if (response.status === 429 && isMonthlyQuotaExhaustion(body)) {
          const resetAt = parseProviderResetAt(body, Date.now());
          const heldUntil = this.recordHold(resetAt);
          throw new QuotaHoldActiveError(heldUntil ?? null);
        }
        if (isRetryableStatus(response.status) && attempt < this.maxAttempts) {
          await delay(retryDelayMs(response, attempt), input.signal);
          continue;
        }
        throw new Error(`Qwen API request failed: HTTP ${response.status} ${redactText(body)}`);
      }
      const responseBody = await readBoundedResponse(response, 10 * 1024 * 1024);
      let data: ChatResponse;
      try {
        data = JSON.parse(responseBody) as ChatResponse;
      } catch (error) {
        // A completed HTTP 200 with an unparsable body still consumed the
        // call: record it as unmetered before failing.
        this.usageLedger?.recordDirectApiUsage(callId, undefined);
        throw error;
      }
      // Record usage immediately after a completed 200 response, BEFORE
      // validating finish_reason or answer content, so malformed answers and
      // output-budget failures are still counted. Missing or malformed usage
      // is recorded as unmetered, never zero. Non-200 responses (including
      // 429) produced no completed call and are never recorded as zero.
      this.usageLedger?.recordDirectApiUsage(callId, data.usage);
      if (data.choices?.[0]?.finish_reason === 'length') throw new QwenOutputError('output_budget');
      const message = data.choices?.[0]?.message;
      const raw = message?.content?.trim() ?? '';
      if (!raw) throw new Error('Qwen API returned no answer content');
      let value: T;
      try { value = parseJson<T>(raw); }
      catch { throw new QwenOutputError('invalid_json'); }
      return {
        value,
        raw,
        reasoning: message?.reasoning_content ?? '',
        usage: data.usage ?? {},
      };
    }
    throw new Error('Qwen API request exhausted its retry budget');
  }

  /**
   * Consult the quota hold for this route. An explicitly injected hold is
   * always honored. Otherwise, on the real network boundary (no injected
   * fetchImpl), the shared durable hold at the harness state root is opened
   * per call and closed again so no database handle ever leaks; clients
   * built with an injected fetchImpl (tests) stay fully isolated.
   */
  private currentHoldUntil(): number | null {
    if (this.quotaHold) return this.quotaHold.heldUntil(this.route);
    if (this.usesInjectedFetch) return null;
    const hold = new ProviderQuotaHold(harnessStateRoot());
    try {
      return hold.heldUntil(this.route);
    } finally {
      hold.close();
    }
  }

  private recordHold(resetAt: number | null): number | null {
    if (this.quotaHold) return this.quotaHold.applyHold(this.route, { resetAt, kind: 'insufficient_quota' });
    if (this.usesInjectedFetch) return null;
    const hold = new ProviderQuotaHold(harnessStateRoot());
    try {
      return hold.applyHold(this.route, { resetAt, kind: 'insufficient_quota' });
    } finally {
      hold.close();
    }
  }
}

async function readBoundedResponse(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error(`Qwen API response exceeds ${limit} bytes`);
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error(`Qwen API response exceeds ${limit} bytes`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export function parseJson<T>(raw: string): T {
  const normalized = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return JSON.parse(normalized) as T;
  } catch {
    const start = normalized.indexOf('{');
    const end = normalized.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(normalized.slice(start, end + 1)) as T;
    throw new Error(`Qwen response was not JSON: ${normalized.slice(0, 500)}`);
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 529 || status === 502 || status === 503 || status === 504;
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfterHeader = response.headers.get('retry-after');
  const retryAfter = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(30_000, retryAfter * 1_000);
  return 250 * 2 ** (attempt - 1);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Qwen API request aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('Qwen API request aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
