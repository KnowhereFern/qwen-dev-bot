import type { ReasoningEffort } from '../core/types.js';
import { DEFAULT_QWEN_BASE_URL, QWEN_HARNESS_MODEL } from './runtime-compat.js';

export const DEFAULT_QWEN_API_TIMEOUT_MS = 5 * 60_000;

export interface QwenApiOptions {
  apiKey?: string;
  credentialEnvKey?: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
}

interface ChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
      reasoning_content?: string;
    };
  }>;
  usage?: Record<string, unknown>;
}

export class QwenApiClient {
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

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
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_QWEN_API_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('Qwen API timeoutMs must be positive');
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts <= 0) throw new Error('Qwen API maxAttempts must be positive');
  }

  async completeJson<T>(input: {
    system: string;
    user: string | Array<Record<string, unknown>>;
    reasoningEffort: ReasoningEffort;
    maxTokens?: number;
    signal?: AbortSignal;
  }): Promise<{ value: T; raw: string; reasoning: string; usage: Record<string, unknown> }> {
    const maxTokens = input.maxTokens ?? 4_096;
    if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) throw new Error('Qwen API maxTokens must be a positive integer');
    const request = {
      model: this.model,
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.user },
      ],
      reasoning_effort: input.reasoningEffort,
      max_tokens: maxTokens,
      temperature: 0,
      enable_thinking: true,
      preserve_thinking: true,
      response_format: { type: 'json_object' },
    };
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      if (input.signal?.aborted) throw new Error('Qwen API request aborted');
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
          throw new Error(`Qwen API request failed after ${attempt} attempt(s): ${error instanceof Error ? error.message : String(error)}`);
        }
        await delay(250 * 2 ** (attempt - 1), input.signal);
        continue;
      }
      if (!response.ok) {
        const body = (await readBoundedResponse(response, 2 * 1024 * 1024)).slice(0, 2_000);
        if (isRetryableStatus(response.status) && attempt < this.maxAttempts) {
          await delay(retryDelayMs(response, attempt), input.signal);
          continue;
        }
        throw new Error(`Qwen API request failed: HTTP ${response.status} ${body}`);
      }
      const data = JSON.parse(await readBoundedResponse(response, 10 * 1024 * 1024)) as ChatResponse;
      const message = data.choices?.[0]?.message;
      const raw = message?.content?.trim() ?? '';
      if (!raw) throw new Error('Qwen API returned no answer content');
      return {
        value: parseJson<T>(raw),
        raw,
        reasoning: message?.reasoning_content ?? '',
        usage: data.usage ?? {},
      };
    }
    throw new Error('Qwen API request exhausted its retry budget');
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
