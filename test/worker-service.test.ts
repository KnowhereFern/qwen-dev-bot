import { readFileSync } from 'node:fs';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installWorkerService } from '../src/installer/service.js';
import { runProcess } from '../src/runtime/safe-process.js';
import { makeTmp } from './helpers.js';

vi.mock('../src/runtime/safe-process.js', () => ({
  runProcess: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const receipt = (exitCode = 0, stderr = '') => ({ command: 'launchctl', args: [], cwd: '', exitCode, stdout: '', stderr, durationMs: 0, timedOut: false, aborted: false });

beforeEach(() => {
  vi.mocked(runProcess).mockReset();
  vi.mocked(runProcess).mockImplementation(async ({ args }) => args?.[0] === 'print' ? receipt(113, 'Could not find service') : receipt());
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  vi.spyOn(os, 'homedir').mockReturnValue(makeTmp('worker-service-home'));
  vi.stubEnv('QWEN_HARNESS_STATE_DIR', makeTmp('worker-service-state'));
});

it('waits for delayed unload before bootstrapping without repeated bootouts', async () => {
  vi.useFakeTimers();
  let prints = 0;
  vi.mocked(runProcess).mockImplementation(async ({ args }) => args?.[0] === 'print' && ++prints <= 2 ? receipt() : args?.[0] === 'print' ? receipt(113) : receipt());
  const pending = installWorkerService('/fixture/bin/qwen-harness.mjs');
  await vi.runAllTimersAsync();
  expect((await pending).installed).toBe(true);
  const calls = vi.mocked(runProcess).mock.calls.map(([call]) => call.args!);
  expect(calls.filter(([verb]) => verb === 'bootout')).toHaveLength(2);
  expect(calls.filter(([verb]) => verb === 'print')).toHaveLength(4);
  expect(calls.at(-1)?.[0]).toBe('bootstrap');
  expect(calls.filter(([verb]) => verb === 'print').every(([, target]) => /^gui\/\d+\/(dev\.qwen-harness\.worker|com\.fern\.qwen-harness)$/.test(target))).toBe(true);
});

it('stops bounded polling without bootstrapping when the previous worker remains registered', async () => {
  vi.useFakeTimers();
  vi.mocked(runProcess).mockResolvedValue(receipt());
  const pending = installWorkerService('/fixture/bin/qwen-harness.mjs');
  await vi.runAllTimersAsync();
  const result = await pending;
  expect(result.installed).toBe(false);
  expect(result.message).toContain('still stopping');
  expect(vi.mocked(runProcess).mock.calls.filter(([call]) => call.args?.[0] === 'print')).toHaveLength(10);
  expect(vi.mocked(runProcess).mock.calls.some(([call]) => call.args?.[0] === 'bootstrap')).toBe(false);
});

it('does not interpret arbitrary launchctl errors as an unloaded worker', async () => {
  vi.mocked(runProcess).mockImplementation(async ({ args }) => args?.[0] === 'print' ? receipt(5, 'Input/output error') : receipt());
  const result = await installWorkerService('/fixture/bin/qwen-harness.mjs');
  expect(result.installed).toBe(false);
  expect(result.message).toContain('Could not verify');
  expect(vi.mocked(runProcess).mock.calls.some(([call]) => call.args?.[0] === 'bootstrap')).toBe(false);
});

it('reports a bootstrap failure with a safe retry instruction, not launchctl root advice', async () => {
  vi.mocked(runProcess).mockImplementation(async ({ args }) => args?.[0] === 'print' ? receipt(113) : args?.[0] === 'bootstrap' ? receipt(5, 'Try re-running the command as root') : receipt());
  const result = await installWorkerService('/fixture/bin/qwen-harness.mjs');
  expect(result.installed).toBe(false);
  expect(result.message).toContain('retry starting the worker');
  expect(result.message).not.toContain('as root');
});

it('sets launchd PATH explicitly rather than relying on an overridden dotenv value', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  vi.spyOn(os, 'homedir').mockReturnValue(makeTmp('worker-service-home'));
  vi.stubEnv('QWEN_HARNESS_STATE_DIR', makeTmp('worker-service-state'));
  vi.stubEnv('PATH', '/opt/homebrew/bin:/tools/A&B:/usr/bin:/bin');
  vi.stubEnv('GH_TOKEN', 'fixture-secret-never-in-plist');
  const result = await installWorkerService('/fixture/bin/qwen-harness.mjs');
  const plist = readFileSync(result.file, 'utf8');
  expect(plist).toContain('<key>EnvironmentVariables</key><dict>');
  expect(plist).toContain('<key>PATH</key><string>/opt/homebrew/bin:/tools/A&amp;B:/usr/bin:/bin</string>');
  expect(plist).not.toContain('fixture-secret-never-in-plist');
  expect(result.installed).toBe(true);
});
