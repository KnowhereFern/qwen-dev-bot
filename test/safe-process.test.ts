import { describe, expect, it } from 'vitest';
import { runProcess } from '../src/runtime/safe-process.js';
import { makeTmp } from './helpers.js';

describe('safe process runner', () => {
  it('preserves UTF-8 characters split across streamed output chunks', async () => {
    let streamed = '';
    const receipt = await runProcess({
      command: process.execPath,
      args: ['-e', "const b=Buffer.from('Fern 🌿'); process.stdout.write(b.subarray(0,7)); setTimeout(()=>process.stdout.write(b.subarray(7)),30)"],
      cwd: makeTmp('process-utf8'), timeoutMs: 5_000,
      onStdout: (chunk) => { streamed += chunk; },
    });
    expect(receipt.exitCode).toBe(0);
    expect(streamed).toBe('Fern 🌿');
    expect(receipt.stdout).toBe(streamed);
  });
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

  it('does not surface a broken pipe when a command exits before reading input', async () => {
    const receipt = await runProcess({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwd: makeTmp('process-early-exit'),
      input: 'y'.repeat(1024 * 1024),
      timeoutMs: 5_000,
    });
    expect(receipt.exitCode).toBe(0);
    expect(receipt.stderr).toBe('');
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
