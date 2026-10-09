import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultProjectConfig } from '../src/core/config.js';
import type { TaskRecord } from '../src/core/types.js';
import { QwenCodeExecutor } from '../src/qwen/qwen-code-executor.js';
import { runProcess } from '../src/runtime/safe-process.js';
import { qwenWriterGuardEnvironment, WRITER_GUARD_FAILURE } from '../src/qwen/writer-guard.js';

vi.mock('../src/runtime/safe-process.js', () => ({ runProcess: vi.fn(), formatProcessFailure: vi.fn(() => 'Process failed') }));
vi.mock('../src/qwen/writer-guard.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/qwen/writer-guard.js')>(),
  qwenWriterGuardEnvironment: vi.fn(() => ({})),
}));

describe('Qwen execution session isolation', () => {
  beforeEach(() => {
    vi.mocked(qwenWriterGuardEnvironment).mockReset().mockReturnValue({});
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
  const execute = (feedback: string[], runTask = task) => new QwenCodeExecutor(defaultProjectConfig('/tmp/project', 'test', 'owner/repo'))
    .execute({ task: runTask, worktree: '/tmp/project', feedback });

  function outcome(exitCode: number | null, state: string | null, options: { timedOut?: boolean; aborted?: boolean; reason?: string; newSession?: string } = {}) {
    vi.mocked(runProcess).mockImplementationOnce(async input => {
      if (options.newSession) input.onStdout?.(`${JSON.stringify({ type: 'system', session_id: options.newSession })}\n`);
      if (state) input.onStdout?.(`${JSON.stringify({ event: { type: 'goal_state', goal_state: { goal: { status: state, lastReason: options.reason } } } })}\n`);
      return { command: input.command, args: input.args ?? [], cwd: input.cwd,
        exitCode, timedOut: options.timedOut ?? false, aborted: options.aborted ?? false, durationMs: 1, stdout: '', stderr: '' };
    });
  }

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

  it('omits resolved controller setup feedback without resuming a failed session or mutating history', async () => {
    const before = structuredClone(task);
    const result = await execute([WRITER_GUARD_FAILURE]);
    const args = vi.mocked(runProcess).mock.calls[0]![0].args!;
    const prompt = args[args.indexOf('--prompt') + 1]!;
    expect(args).not.toContain('--resume');
    expect(prompt).toMatch(/^\/goal You are/);
    expect(prompt).not.toContain(WRITER_GUARD_FAILURE);
    expect(result.sessionId).toBeNull();
    expect(result.workflowRunId).toBeNull();
    expect(task).toEqual(before);
  });

  it('retains real verifier failures alongside a resolved setup failure', async () => {
    await execute([WRITER_GUARD_FAILURE, 'Writer guard behavior test failed']);
    const args = vi.mocked(runProcess).mock.calls[0]![0].args!;
    const prompt = args[args.indexOf('--prompt') + 1]!;
    expect(prompt).not.toContain(WRITER_GUARD_FAILURE);
    expect(prompt).toContain('Writer guard behavior test failed');
    expect(prompt).toContain('new bounded repair attempt');
  });

  it('never launches a session when the current guard still fails', async () => {
    vi.mocked(qwenWriterGuardEnvironment).mockImplementation(() => { throw new Error(WRITER_GUARD_FAILURE); });
    await expect(execute([WRITER_GUARD_FAILURE])).rejects.toThrow(WRITER_GUARD_FAILURE);
    expect(runProcess).not.toHaveBeenCalled();
  });

  it.each([
    { exitCode: 53, timedOut: false, kind: 'turn-limit' },
    { exitCode: 55, timedOut: false, kind: 'budget-limit' },
    { exitCode: null, timedOut: true, kind: 'process-timeout' },
  ])('records automatic-stop provenance from the real $kind outcome', async ({ exitCode, timedOut, kind }) => {
    outcome(exitCode, 'paused', { timedOut });
    const result = await execute([]);
    expect(result).toMatchObject({ needsContinuation: true, continuationKind: 'budget', automaticStop: { sessionId: 'prior-session', workflowRunId: 'prior-workflow', kind } });
  });

  it('starts a fresh local Goal only for a matching automatic-stop record, preserving the candidate and counters', async () => {
    const stoppedTask: TaskRecord = { ...task, continuations: 2, qwenAutomaticStop: { sessionId: task.qwenSessionId!, workflowRunId: task.qwenWorkflowRunId, kind: 'budget-limit' } };
    const before = structuredClone(stoppedTask);
    const result = await execute([], stoppedTask);
    const options = vi.mocked(runProcess).mock.calls[0]![0];
    expect(options.args).not.toContain('--resume');
    expect(options.cwd).toBe('/tmp/project');
    const prompt = options.args![options.args!.indexOf('--prompt') + 1]!;
    expect(prompt).toMatch(/^\/goal You are/);
    expect(prompt).toContain('automatic budget continuation in a fresh local Goal');
    expect(prompt).toContain('Keep the approved contract.');
    expect(prompt).toContain('attempt and continuation counters');
    expect(prompt).toContain('does not override genuine user instructions to stop');
    expect(prompt).toContain('fresh, without resumeFromRunId');
    expect(prompt).not.toContain('may resume its workflow');
    expect(prompt).not.toContain('new bounded repair attempt');
    expect(result.sessionId).toBeNull();
    expect(result.workflowRunId).toBeNull();
    expect(result.automaticStop).toBeNull();
    expect(stoppedTask).toEqual(before);
  });

  it.each([
    { sessionId: 'other-session', workflowRunId: 'prior-workflow', kind: 'budget-limit' },
    { sessionId: 'prior-session', workflowRunId: 'other-workflow', kind: 'budget-limit' },
    { sessionId: 'prior-session', workflowRunId: 'prior-workflow', kind: 'unknown' },
  ])('does not use stale or unknown automatic-stop metadata %j', async marker => {
    await execute([], { ...task, qwenAutomaticStop: marker as TaskRecord['qwenAutomaticStop'] });
    const args = vi.mocked(runProcess).mock.calls[0]![0].args!;
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--prompt') + 1]).toBe('/goal resume');
  });

  it('keeps real verifier repair feedback authoritative over an automatic-stop marker', async () => {
    await execute(['Required test failed'], { ...task, qwenAutomaticStop: { sessionId: task.qwenSessionId!, workflowRunId: task.qwenWorkflowRunId, kind: 'budget-limit' } });
    const args = vi.mocked(runProcess).mock.calls[0]![0].args!;
    const prompt = args[args.indexOf('--prompt') + 1]!;
    expect(prompt).toContain('new bounded repair attempt');
    expect(prompt).toContain('Required test failed');
    expect(prompt).not.toContain('automatic budget continuation');
  });

  it.each([
    { exitCode: 0, state: 'paused', reason: 'token budget exceeded' },
    { exitCode: 0, state: 'usage_limited', reason: 'provider quota' },
    { exitCode: 55, state: 'usage_limited', reason: 'provider quota' },
    { exitCode: 55, state: 'complete', reason: 'complete' },
  ])('does not manufacture automatic-stop provenance for %j', async ({ exitCode, state, reason }) => {
    outcome(exitCode, state, { reason });
    expect((await execute([])).automaticStop).toBeNull();
  });

  it.each([
    { exitCode: 130, state: 'paused', aborted: false, timedOut: false },
    { exitCode: 55, state: 'paused', aborted: true, timedOut: true },
    { exitCode: 55, state: 'paused', aborted: false, timedOut: false },
    { exitCode: null, state: 'paused', aborted: false, timedOut: true },
    { exitCode: 55, state: 'cancelled', aborted: false, timedOut: false },
    { exitCode: 55, state: 'blocked', aborted: false, timedOut: false },
    { exitCode: null, state: 'cancelled', aborted: false, timedOut: true },
    { exitCode: null, state: 'blocked', aborted: false, timedOut: true },
    { exitCode: 0, state: 'paused', aborted: false, timedOut: false },
  ])('never grants automatic continuation for cancellation or a genuine stop %j', async ({ exitCode, state, aborted, timedOut }) => {
    outcome(exitCode, state, { aborted, timedOut, reason: 'manual user stop' });
    await expect(execute([])).rejects.toThrow();
  });

  it('preserves the native user-interrupt pause over a conflicting budget exit', async () => {
    outcome(55, 'paused', { reason: 'Interrupted by the user. Run /goal resume to continue.' });
    await expect(execute([])).rejects.toThrow('Qwen goal stopped in paused state');
  });

  it('requires an observed session ID before issuing new automatic-stop provenance', async () => {
    outcome(55, 'paused');
    expect((await execute([], { ...task, qwenSessionId: null, qwenWorkflowRunId: null })).automaticStop).toBeNull();
    outcome(55, 'paused', { newSession: 'new-session' });
    expect((await execute([], { ...task, qwenSessionId: null, qwenWorkflowRunId: null })).automaticStop).toEqual({ sessionId: 'new-session', workflowRunId: null, kind: 'budget-limit' });
  });
});
