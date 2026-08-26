import { describe, expect, it } from 'vitest';
import { runProcess } from '../src/runtime/safe-process.js';
import { makeTmp } from './helpers.js';

describe('safe process runner', () => {
  it('passes arguments without shell interpretation', async () => {
    const receipt = await runProcess({
      command: process.execPath,
      args: ['-e', 'console.log(process.argv[1])', '$(echo injected);`whoami`'],
      cwd: makeTmp('safe-process'),
      timeoutMs: 5_000,
    });
    expect(receipt.exitCode).toBe(0);
    expect(receipt.stdout.trim()).toBe('$(echo injected);`whoami`');
  });

  it('bounds hung process trees', async () => {
    const receipt = await runProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: makeTmp('process-timeout'),
      timeoutMs: 50,
    });
    expect(receipt.timedOut).toBe(true);
    expect(receipt.exitCode).not.toBe(0);
  });

  it('honors a signal that was already aborted before spawn', async () => {
    const controller = new AbortController();
    controller.abort();
    const receipt = await runProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: makeTmp('process-pre-abort'),
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    expect(receipt.aborted).toBe(true);
    expect(receipt.exitCode).not.toBe(0);
  });
});
