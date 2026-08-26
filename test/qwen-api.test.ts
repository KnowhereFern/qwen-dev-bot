import { describe, expect, it, vi } from 'vitest';
import { QwenApiClient } from '../src/qwen/qwen-api.js';

describe('Qwen API boundary', () => {
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
});
