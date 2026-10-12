import { describe, expect, it } from 'vitest';
import { QwenStructuredResultCollector } from '../src/qwen/structured-result.js';

function terminal(result: unknown): string {
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result });
}

function collect(chunks: string[]): unknown {
  const collector = new QwenStructuredResultCollector();
  for (const chunk of chunks) collector.push(chunk);
  return collector.finish();
}

describe('QwenStructuredResultCollector', () => {
  it('extracts a small final result after more than 64 KB of preceding events', () => {
    const progress = `${JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(1_024) } })}\n`;
    expect(progress.length * 100).toBeGreaterThan(64 * 1_024);
    expect(collect([...Array.from({ length: 100 }, () => progress), `${terminal({ ok: true })}\n`]))
      .toEqual({ ok: true });
  });

  it('accepts object payloads with arbitrarily split event chunks', () => {
    const stream = `${JSON.stringify({ type: 'system', subtype: 'init' })}\n${terminal({ coverage: [{ id: 'HEALTH' }] })}\n`;
    expect(collect(Array.from(stream))).toEqual({ coverage: [{ id: 'HEALTH' }] });
  });

  it('preserves a JSON string payload and accepts a final frame without newline', () => {
    expect(collect([terminal(JSON.stringify({ ok: true }))])).toBe(JSON.stringify({ ok: true }));
  });

  it('does not accept a fake result embedded in an assistant message', () => {
    expect(() => collect([`${JSON.stringify({ type: 'assistant', result: { ok: true }, message: terminal({ ok: true }) })}\n`]))
      .toThrow();
  });

  it.each([
    ['empty', ''],
    ['duplicate terminal', `${terminal({ ok: true })}\n${terminal({ ok: false })}\n`],
    ['error terminal', `${JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'private-provider-error' })}\n`],
    ['error flag on success', `${JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: {} })}\n`],
    ['missing payload', `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false })}\n`],
    ['malformed frame', `private-secret malformed-json\n${terminal({ ok: true })}\n`],
    ['truncated frame', `${terminal({ ok: true })}\n{"type":"private-secret`],
    ['oversized complete frame', `${JSON.stringify({ type: 'assistant', content: 'x'.repeat(1_024 * 1_024) })}\n${terminal({ ok: true })}\n`],
    ['oversized partial frame', 'x'.repeat(1_024 * 1_024 + 1)],
  ])('fails closed on %s without reflecting raw stream content', (_name, stream) => {
    let error: unknown;
    try { collect([stream]); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('private-secret');
    expect((error as Error).message).not.toContain('private-provider-error');
    expect((error as Error).message.length).toBeLessThan(1_024);
  });

  it('bounds oversized frames across multiple chunks rather than per chunk', () => {
    expect(() => collect(Array.from({ length: 17 }, () => 'x'.repeat(64 * 1_024)))).toThrow();
  });
});
