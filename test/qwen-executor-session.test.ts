import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultProjectConfig } from '../src/core/config.js';
import type { TaskRecord } from '../src/core/types.js';
import { QwenCodeExecutor } from '../src/qwen/qwen-code-executor.js';
import { runProcess } from '../src/runtime/safe-process.js';

vi.mock('../src/runtime/safe-process.js', () => ({ runProcess: vi.fn() }));
vi.mock('../src/qwen/writer-guard.js', () => ({ qwenWriterGuardEnvironment: () => ({}) }));

describe('Qwen execution session isolation', () => {
  beforeEach(() => {
    vi.mocked(runProcess).mockReset();
    vi.mocked(runProcess).mockImplementation(async (options) => {
      options.onStdout?.(`${JSON.stringify({ event: { type: 'goal_state', state: 'complete' } })}\n`);
      return { command: options.command, args: options.args ?? [], cwd: options.cwd,
        exitCode: 0, timedOut: false, aborted: false, durationMs: 1, stdout: '', stderr: '' };
    });
  });

  const task = {
    id: 'task', issueNumber: 35, title: 'Verify existing behavior', body: 'Keep the approved contract.',
    spec: null, qwenSessionId: 'prior-session', qwenWorkflowRunId: 'prior-workflow', attempts: 7,
  } as TaskRecord;
  const execute = (feedback: string[]) => new QwenCodeExecutor(defaultProjectConfig('/tmp/project', 'test', 'owner/repo'))
    .execute({ task, worktree: '/tmp/project', feedback });

  it('does not resume failed chat or workflow state for a bounded repair', async () => {
    const result = await execute(['Independent acceptance check failed']);
    const args = vi.mocked(runProcess).mock.calls[0]![0].args!;
    expect(args).not.toContain('--resume');
    const prompt = args[args.indexOf('--prompt') + 1]!;
    expect(prompt).toContain('new bounded repair attempt in a fresh session');
    expect(prompt).toContain('failure history, and controller retry limits remain in force');
    expect(prompt).toContain('Independent acceptance check failed');
    expect(result.sessionId).toBeNull();
    expect(result.workflowRunId).toBeNull();
    expect(task.attempts).toBe(7);
    expect(task.qwenSessionId).toBe('prior-session');
  });

  it('preserves ordinary provider or budget continuation checkpoints without repair feedback', async () => {
    const result = await execute([]);
    const args = vi.mocked(runProcess).mock.calls[0]![0].args!;
    expect(args.slice(args.indexOf('--resume'))).toEqual(['--resume', 'prior-session']);
    expect(args[args.indexOf('--prompt') + 1]).toBe('/goal resume');
    expect(result.sessionId).toBe('prior-session');
    expect(result.workflowRunId).toBe('prior-workflow');
  });
});
