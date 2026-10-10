import { describe, expect, it, vi } from 'vitest';
import { readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeTmp } from './helpers.js';
import { renderTerminalScreen, startTerminalActivity, wrapTerminalLine } from '../src/terminal/presentation.js';
import { deploymentLabel } from '../src/terminal/home.js';
import type { DeploymentRecord } from '../src/core/types.js';
import { saveUserModelCredential } from '../src/terminal/model-connection.js';
import { resolveQwenCredential } from '../src/qwen/credential-resolver.js';

describe('terminal feedback and credentials', () => {
  it('uses restrained styling only when enabled and strips control sequences from screen evidence', () => {
    const lines = [{ text: '  Fern Delivery\x1b]0;injected\x07', tone: 'title' as const }, { text: 'Bearer super-secret\x1b[2J' }];
    const plain = renderTerminalScreen(lines);
    expect(plain).not.toContain('\x1b');
    expect(plain).not.toContain('injected');
    expect(plain).not.toContain('super-secret');
    const colored = renderTerminalScreen(lines, { color: true });
    expect(colored).toContain('\x1b[1;36m');
    expect(colored).not.toContain('\x1b[2J');
  });

  it('keeps long folders and Unicode readable in narrow terminals without dropping text', () => {
    const value = `  Folder: /${'very-long-project-name/'.repeat(3)}Festival 🎪 東京`;
    const wrapped = wrapTerminalLine(value, 30);
    expect(wrapped.every((line) => Array.from(line).length <= 30)).toBe(true);
    expect(wrapped.join('').replace(/ /g, '')).toBe(value.replace(/ /g, ''));
    expect(wrapped.join('')).toContain('🎪');
  });

  it('stacks menu choices on narrow screens and only compresses whitespace in short windows', () => {
    const choices: [string, string] = ['1  Review plan', '2  Create plan'];
    const lines = [{ text: '' }, { text: '  1  Review plan\n  2  Create plan', choices }, { text: '' }, { text: 'Nothing starts here' }];
    const wide = renderTerminalScreen(lines, { columns: 80 });
    expect(wide.split('\n').find((line) => line.includes('Review plan'))).toContain('Create plan');
    const narrow = renderTerminalScreen(lines, { columns: 35, rows: 5 });
    expect(narrow).toContain('  1  Review plan\n  2  Create plan');
    expect(narrow).toContain('Nothing starts here');
    expect(narrow).not.toContain('\n\n');
  });

  it('never calls a deployment verified without the exact observed revision', () => {
    const deployment = { status: 'succeeded', commitSha: 'abcdef1234', observedRevision: 'old-revision' } as DeploymentRecord;
    expect(deploymentLabel(deployment)).toContain('revision not verified');
    deployment.observedRevision = deployment.commitSha;
    expect(deploymentLabel(deployment)).toBe('Verified at abcdef12 (recorded result)');
  });

  it('animates real elapsed activity without inventing percentage progress, then stops', async () => {
    vi.useFakeTimers();
    try {
      const write = vi.fn();
      const activity = startTerminalActivity('Assessing repository', { write, animated: true, columns: () => 80 });
      await vi.advanceTimersByTimeAsync(1_200);
      const output = write.mock.calls.flat().join('');
      expect(output).toContain('1s');
      expect(output).toContain('⠙');
      expect(output).not.toContain('%');
      activity.stop(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(write.mock.calls.flat().join('')).toContain('Completed');
    } finally { vi.useRealTimers(); }
  });

  it('supports reduced motion and cleans up failed command feedback', () => {
    const write = vi.fn();
    const activity = startTerminalActivity('Connecting model', { write, animated: false });
    activity.stop(false);
    const output = write.mock.calls.flat().join('');
    expect(output).toContain('Working: Connecting model');
    expect(output).toContain('Failed/interrupted');
    expect(output).not.toContain('\x1b');
  });

  it('preserves unrelated credentials and writes a resolver-compatible owner-only key file', () => {
    const user = makeTmp('credential-save');
    const file = path.join(user, '.env');
    writeFileSync(file, '# Existing settings\nOTHER_KEY=keep-this\nexport DASHSCOPE_API_KEY=old-key\n');
    saveUserModelCredential('DASHSCOPE_API_KEY', 'new-model-key', user);
    expect(readFileSync(file, 'utf8')).toContain('OTHER_KEY=keep-this');
    expect(readFileSync(file, 'utf8')).not.toContain('old-key');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    const result = resolveQwenCredential({ qwen: { credentialEnvKey: 'DASHSCOPE_API_KEY' } } as Parameters<typeof resolveQwenCredential>[0], {
      environment: {}, workerEnvironmentFile: path.join(user, 'absent-worker'), qwenSettingsFile: path.join(user, 'absent-settings'), qwenEnvironmentFile: file,
    });
    expect(result?.apiKey).toBe('new-model-key');
  });

  it('rejects invalid keys and environment-variable injection without echoing secrets', () => {
    expect(() => saveUserModelCredential('BAD\nNAME', 'safe-key', makeTmp('bad-env'))).toThrow('uppercase environment');
    expect(() => saveUserModelCredential('MODEL_KEY', 'private\nvalue', makeTmp('bad-key'))).toThrow('Invalid credential');
  });

  it.skipIf(process.platform === 'win32')('does not follow a symlink to overwrite an unrelated credential file', () => {
    const user = makeTmp('credential-link');
    const target = path.join(user, 'existing');
    writeFileSync(target, 'preserved');
    symlinkSync(target, path.join(user, '.env'));
    expect(() => saveUserModelCredential('MODEL_KEY', 'new-key', user)).toThrow('symlinked');
    expect(readFileSync(target, 'utf8')).toBe('preserved');
  });
});
