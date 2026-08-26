import { afterEach, describe, expect, it } from 'vitest';
import { redactForLedger, redactText } from '../src/core/ledger.js';
import { Logger } from '../src/logger.js';

const priorToken = process.env.QWEN_HARNESS_TEST_TOKEN;
afterEach(() => {
  if (priorToken === undefined) delete process.env.QWEN_HARNESS_TEST_TOKEN;
  else process.env.QWEN_HARNESS_TEST_TOKEN = priorToken;
});

describe('credential redaction', () => {
  it('redacts known formats, credential URLs, and configured environment secrets', () => {
    process.env.QWEN_HARNESS_TEST_TOKEN = 'unusual-secret-value-123456';
    const redacted = redactText(
      'Bearer abc.def sk-abcdefghijklmnopqrstuvwxyz https://user:password@github.test unusual-secret-value-123456',
    );
    expect(redacted).not.toContain('abc.def');
    expect(redacted).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(redacted).not.toContain('password@');
    expect(redacted).not.toContain('unusual-secret-value-123456');
  });

  it('redacts structured event fields and logger output', () => {
    const records: unknown[] = [];
    new Logger({ sink: (record) => records.push(record) }).error('failed', {
      authorization: 'Bearer should-not-appear',
      stderr: 'github_pat_abcdefghijklmnopqrstuvwxyz123456',
    });
    const encoded = JSON.stringify(records);
    expect(encoded).not.toContain('should-not-appear');
    expect(encoded).not.toContain('github_pat_abcdefghijklmnopqrstuvwxyz123456');
    expect(redactForLedger({ apiKey: 'anything' })).toEqual({ apiKey: '[REDACTED]' });
  });
});
