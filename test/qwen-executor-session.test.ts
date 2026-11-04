import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultProjectConfig } from '../src/core/config.js';
import type { TaskRecord } from '../src/core/types.js';
import { ObservedTokenBudget, UsageBudgetActiveError, UsageLedger } from '../src/core/usage-ledger.js';
import { QwenCodeExecutor } from '../src/qwen/qwen-code-executor.js';
import { ProviderQuotaHold, providerRouteFromConfig, QuotaHoldActiveError } from '../src/qwen/quota-hold.js';
import { runProcess } from '../src/runtime/safe-process.js';
import { qwenWriterGuardEnvironment, WRITER_GUARD_FAILURE } from '../src/qwen/writer-guard.js';
import { makeTmp } from './helpers.js';

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
      if (state || options.reason) input.onStdout?.(`${JSON.stringify({ event: { type: 'goal_state', goal_state: { goal: { status: state, lastReason: options.reason } } } })}\n`);
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
    expect(prompt).toContain('executionFocus field in the saved workflow args');
    expect(prompt).toContain('missing acceptance test or next required edit');
    expect(prompt).toContain('sole implementer');
    expect(prompt).toContain('unchanged required gates and independent review');
    expect(prompt).toContain('fresh, without resumeFromRunId');
    expect(prompt).not.toContain('may resume its workflow');
    expect(prompt).not.toContain('new bounded repair attempt');
    expect(result.sessionId).toBeNull();
    expect(result.workflowRunId).toBeNull();
    expect(result.automaticStop).toBeNull();
    expect(stoppedTask).toEqual(before);
  });

  it('directs a repair of a task-owned worktree with prior counters to focused inspection and executionFocus.nextAction', async () => {
    const repairTask: TaskRecord = {
      ...task, attempts: 1, continuations: 8,
      worktreePath: '/tmp/project/worktrees/task-212',
      qwenAutomaticStop: null, qwenSessionId: 'prior-session', qwenWorkflowRunId: 'prior-workflow',
    };
    await execute(['Required gate check failed'], repairTask);
    const args = vi.mocked(runProcess).mock.calls[0]![0].args!;
    expect(args).not.toContain('--resume');
    const prompt = args[args.indexOf('--prompt') + 1]!;
    expect(prompt).toContain('new bounded repair attempt in a fresh session');
    expect(prompt).toContain('prior attempts or continuations');
    expect(prompt).toContain('at most focused inspection of the existing candidate and the gate receipt');
    expect(prompt).toMatch(/Do not repeat broad repository reconnaissance/);
    expect(prompt).toContain('executionFocus');
    expect(prompt).toContain('nextAction');
    expect(prompt).toContain('then immediately invoke the saved workflow');
    expect(prompt).toContain('unchanged required gates and independent review');
    expect(prompt).toContain('single-writer rule');
    expect(prompt).toContain('grants no new authority');
    expect(prompt).toContain('Required gate check failed');
    expect(prompt).not.toContain('automatic budget continuation');
    expect(prompt).toContain('fresh workflow without resumeFromRunId');
  });

  it('does not assert an existing candidate from counters alone when worktreePath is null', async () => {
    const repairTask: TaskRecord = { ...task, attempts: 1, continuations: 8, worktreePath: null };
    await execute(['Required gate check failed'], repairTask);
    const args = vi.mocked(runProcess).mock.calls[0]![0].args!;
    const prompt = args[args.indexOf('--prompt') + 1]!;
    expect(prompt).toContain('new bounded repair attempt in a fresh session');
    expect(prompt).not.toContain('prior attempts or continuations');
    expect(prompt).not.toContain('executionFocus');
    expect(prompt).not.toContain('at most focused inspection');
  });

  it('keeps the first run on full reconnaissance without focused-repair wording', async () => {
    const firstRunTask: TaskRecord = { ...task, attempts: 1, continuations: 0, worktreePath: '/tmp/project/worktrees/task-212' };
    await execute([], firstRunTask);
    const args = vi.mocked(runProcess).mock.calls[0]![0].args!;
    const prompt = args[args.indexOf('--prompt') + 1]!;
    expect(prompt).not.toContain('executionFocus');
    expect(prompt).not.toContain('at most focused inspection');
    expect(prompt).not.toContain('prior attempts or continuations');
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
    expect(prompt).not.toContain('executionFocus');
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

  const quotaReason = 'The headless run stopped: Quota exhausted: Your token-plan 1-month quota has been exhausted.';

  it.each([
    { state: 'paused', reason: quotaReason },
    { state: 'usage_limited', reason: 'provider quota exhausted' },
    { state: 'waiting', reason: quotaReason },
  ])('admits exit 1 only as a resumable provider wait with preserved sessions %j', async ({ state, reason }) => {
    outcome(1, state, { reason });
    const result = await execute([]);
    expect(result).toMatchObject({
      sessionId: 'prior-session',
      workflowRunId: 'prior-workflow',
      needsContinuation: true,
      continuationKind: 'provider',
      automaticStop: null,
    });
  });

  it.each([
    { state: 'paused', reason: 'Interrupted by the user. Run /goal resume to continue.' },
    { state: 'failed', reason: quotaReason },
    { state: 'complete', reason: quotaReason },
    { state: null, reason: quotaReason },
    { state: 'active', reason: quotaReason },
    { state: 'running', reason: quotaReason },
    { state: 'unknown', reason: quotaReason },
    { state: 'paused', reason: 'unrecoverable crash' },
  ])('keeps exit 1 a hard failure without an explicit resumable provider wait %j', async ({ state, reason }) => {
    outcome(1, state, { reason });
    await expect(execute([])).rejects.toThrow();
  });

  it.each([
    { exitCode: 1, aborted: true },
    { exitCode: 130, aborted: false },
    { exitCode: 2, aborted: false },
  ])('rejects aborts, signals, and other nonzero exits despite quota wording %j', async ({ exitCode, aborted }) => {
    outcome(exitCode, 'paused', { reason: quotaReason, aborted });
    await expect(execute([])).rejects.toThrow();
  });

  const contextExhaustionReason =
    'Context is too large to send safely after automatic compression. Estimated prompt tokens ~979k; hard limit 977000; compression status: NOOP. Start a new session or reduce the resumed history before continuing.';

  it('classifies the exact exit-1 context-exhaustion pause as a local process boundary', async () => {
    outcome(1, 'paused', { reason: contextExhaustionReason });
    const before = structuredClone(task);
    const result = await execute([]);
    expect(result).toMatchObject({
      sessionId: 'prior-session',
      workflowRunId: 'prior-workflow',
      needsContinuation: true,
      continuationKind: 'budget',
      automaticStop: { sessionId: 'prior-session', workflowRunId: 'prior-workflow', kind: 'context-exhausted' },
    });
    expect(task).toEqual(before);
  });

  it('also accepts a clean exit-0 context-exhaustion pause on a known session', async () => {
    outcome(0, 'waiting', { reason: contextExhaustionReason });
    const result = await execute([]);
    expect(result).toMatchObject({
      needsContinuation: true,
      continuationKind: 'budget',
      automaticStop: { sessionId: 'prior-session', workflowRunId: 'prior-workflow', kind: 'context-exhausted' },
    });
  });

  it('keeps a verified context-exhaustion pause a budget boundary even when the reason also carries provider/quota wording', async () => {
    // Regression: the structured context-exhaustion message may also mention
    // quota/provider limits. The verified contextExhaustedExit must take
    // precedence over isProviderWaiting in both classifyGoalDisposition and
    // continuationKind, so the run is a budget continuation with a
    // context-exhausted automatic stop and the next run starts a fresh Goal.
    const mixedReason = `${contextExhaustionReason} Provider quota exhausted: retry when the service is available.`;
    outcome(1, 'paused', { reason: mixedReason });
    const result = await execute([]);
    expect(result).toMatchObject({
      sessionId: 'prior-session',
      workflowRunId: 'prior-workflow',
      needsContinuation: true,
      continuationKind: 'budget',
      automaticStop: { sessionId: 'prior-session', workflowRunId: 'prior-workflow', kind: 'context-exhausted' },
    });
    // The persisted stop makes the next execution a fresh local Goal, never a
    // resume of the unresumable session.
    const stoppedTask: TaskRecord = {
      ...task,
      qwenSessionId: result.sessionId,
      qwenWorkflowRunId: result.workflowRunId,
      qwenAutomaticStop: result.automaticStop,
    };
    await execute([], stoppedTask);
    const args = vi.mocked(runProcess).mock.calls.at(-1)![0].args!;
    expect(args).not.toContain('--resume');
    const prompt = args[args.indexOf('--prompt') + 1]!;
    expect(prompt).toMatch(/^\/goal You are/);
    expect(prompt).toContain('context-exhausted local process boundary');
  });

  it('rejects the context-exhaustion reason without a known session ID', async () => {
    outcome(1, 'paused', { reason: contextExhaustionReason, newSession: undefined });
    await expect(execute([], { ...task, qwenSessionId: null, qwenWorkflowRunId: null })).rejects.toThrow();
  });

  it('keeps exit 1 fail-closed for an oversized context-exhaustion reason', async () => {
    // Same multi-marker content, but padded past the accepted length cap so
    // the untrusted structured reason is never scanned unbounded.
    const oversized = `${contextExhaustionReason} ${'x'.repeat(2_100)}`;
    expect(oversized.length).toBeGreaterThan(2_000);
    outcome(1, 'paused', { reason: oversized });
    await expect(execute([])).rejects.toThrow();
    // A reason exactly at the cap is still admitted when every marker matches.
    const atCap = contextExhaustionReason + ' '.repeat(2_000 - contextExhaustionReason.length);
    expect(atCap.length).toBe(2_000);
    outcome(1, 'paused', { reason: atCap });
    await expect(execute([])).resolves.toMatchObject({ needsContinuation: true });
  });

  it.each([
    'Context is too large to send safely. Start a new session.',
    'Estimated prompt tokens ~979k; hard limit 977000; compression status: NOOP.',
    'Context is too large to send safely after automatic compression. Reduce the resumed history.',
    contextExhaustionReason.replace('Start a new session', 'Begin another session'),
    `${contextExhaustionReason} Interrupted by the user.`,
  ])('keeps exit 1 fail-closed for near-miss or conflicting reasons %j', async reason => {
    outcome(1, 'paused', { reason });
    await expect(execute([])).rejects.toThrow();
  });

  it.each([
    { exitCode: 1, state: 'failed' },
    { exitCode: 1, state: 'cancelled' },
    { exitCode: 1, state: 'blocked' },
    { exitCode: 2, state: 'paused' },
    { exitCode: 130, state: 'paused' },
  ])('keeps other states and exits fail-closed despite the exact reason %j', async ({ exitCode, state }) => {
    outcome(exitCode, state, { reason: contextExhaustionReason });
    await expect(execute([])).rejects.toThrow();
  });

  it('never treats a completed or missing goal_state as context exhaustion', async () => {
    outcome(1, 'complete', { reason: contextExhaustionReason });
    await expect(execute([])).rejects.toThrow();
    outcome(1, null, { reason: contextExhaustionReason });
    await expect(execute([])).rejects.toThrow();
  });

  it('never spawns a Qwen Code process while the provider route is held', async () => {
    const quotaHold = new ProviderQuotaHold(makeTmp('executor-quota'));
    try {
      const config = defaultProjectConfig('/tmp/project', 'test', 'owner/repo');
      const heldUntil = quotaHold.applyHold(providerRouteFromConfig(config.qwen), {
        resetAt: Date.now() + 2 * 60 * 60_000,
        kind: 'insufficient_quota',
      });
      const executor = new QwenCodeExecutor(config, null, quotaHold);
      await expect(executor.execute({ task, worktree: '/tmp/project', feedback: [] }))
        .rejects.toMatchObject({ name: 'QuotaHoldActiveError', heldUntil });
      expect(runProcess).not.toHaveBeenCalled();
      // Unrelated routes are unaffected.
      const other = new ProviderQuotaHold(makeTmp('executor-quota-other'));
      try {
        expect(other.heldUntil(providerRouteFromConfig(config.qwen), Date.now())).toBeNull();
      } finally { other.close(); }
    } finally { quotaHold.close(); }
  });

  it('never spawns a Qwen Code process while the observed-token budget blocks calls', async () => {
    const ledger = new UsageLedger('exec-budget', makeTmp('exec-budget'));
    try {
      ledger.recordDirectApiUsage('seed-call', { total_tokens: 500 });
      const budget = new ObservedTokenBudget(500, ledger);
      const executor = new QwenCodeExecutor(defaultProjectConfig('/tmp/project', 'test', 'owner/repo'), null, undefined, null, budget);
      await expect(executor.execute({ task, worktree: '/tmp/project', feedback: [] }))
        .rejects.toMatchObject({ name: 'UsageBudgetActiveError', status: { reason: 'limit-reached' } });
      expect(runProcess).not.toHaveBeenCalled();
    } finally { ledger.close(); }
  });

  it('starts a subsequent fresh local Goal without resume after a context-exhausted stop', async () => {
    const stoppedTask: TaskRecord = { ...task, continuations: 3, qwenAutomaticStop: { sessionId: task.qwenSessionId!, workflowRunId: task.qwenWorkflowRunId, kind: 'context-exhausted' } };
    const before = structuredClone(stoppedTask);
    const result = await execute([], stoppedTask);
    const options = vi.mocked(runProcess).mock.calls[0]![0];
    expect(options.args).not.toContain('--resume');
    const prompt = options.args![options.args!.indexOf('--prompt') + 1]!;
    expect(prompt).toMatch(/^\/goal You are/);
    expect(prompt).toContain('automatic context-boundary continuation in a fresh local Goal');
    expect(prompt).toContain('context-exhausted local process boundary');
    expect(prompt).toContain('can no longer be resumed');
    expect(prompt).toContain('same worktree');
    expect(prompt).toContain('attempt and continuation counters');
    expect(prompt).toContain('does not override genuine user instructions to stop');
    expect(prompt).toContain('fresh, without resumeFromRunId');
    expect(prompt).not.toContain('automatic budget continuation');
    expect(prompt).not.toContain('may resume its workflow');
    expect(result.sessionId).toBeNull();
    expect(result.workflowRunId).toBeNull();
    expect(result.automaticStop).toBeNull();
    expect(stoppedTask).toEqual(before);
  });
});

describe('Qwen executor usage ledger integration', () => {
  const task = {
    id: 'task', issueNumber: 35, title: 'Verify existing behavior', body: 'Keep the approved contract.',
    spec: null, qwenSessionId: 'prior-session', qwenWorkflowRunId: 'prior-workflow', attempts: 7,
  } as TaskRecord;

  beforeEach(() => {
    vi.mocked(qwenWriterGuardEnvironment).mockReset().mockReturnValue({});
    vi.mocked(runProcess).mockReset();
  });

  const execute = (ledger: UsageLedger) => new QwenCodeExecutor(defaultProjectConfig('/tmp/project', 'test', 'owner/repo'), null, undefined, ledger)
    .execute({ task, worktree: '/tmp/project', feedback: [] });

  /** One mocked run whose stdout carries the given stream events. */
  function streamRun(lines: Array<Record<string, unknown>>, exitCode = 0) {
    vi.mocked(runProcess).mockImplementationOnce(async input => {
      for (const line of lines) input.onStdout?.(`${JSON.stringify(line)}\n`);
      return { command: input.command, args: input.args ?? [], cwd: input.cwd,
        exitCode, timedOut: false, aborted: false, durationMs: 1, stdout: '', stderr: '' };
    });
  }

  it('records cumulative session usage from result events, counting only the session maximum', async () => {
    const ledger = new UsageLedger('exec-usage-ok', makeTmp('exec-usage-ok'));
    try {
      streamRun([
        { type: 'system', session_id: 'session-a' },
        { type: 'result', session_id: 'session-a', usage: { total_tokens: 10 } },
        { type: 'result', session_id: 'session-a', usage: { total_tokens: 25 } },
      ]);
      const result = await execute(ledger);
      expect(result.sessionId).toBe('session-a');
      expect(ledger.summary()).toMatchObject({
        qwenSessionCount: 1, observedTotalTokens: 25, unmeteredCount: 0, directCallCount: 0,
      });
    } finally { ledger.close(); }
  });

  it('records session usage for runs that later fail', async () => {
    const ledger = new UsageLedger('exec-usage-fail', makeTmp('exec-usage-fail'));
    try {
      streamRun([
        { type: 'system', session_id: 'session-fail' },
        { type: 'result', session_id: 'session-fail', usage: { total_tokens: 13 } },
        { event: { type: 'goal_state', goal_state: { goal: { status: 'paused', lastReason: 'manual user stop' } } } },
      ], 130);
      await expect(execute(ledger)).rejects.toThrow();
      expect(ledger.summary()).toMatchObject({ qwenSessionCount: 1, observedTotalTokens: 13, unmeteredCount: 0 });
    } finally { ledger.close(); }
  });

  it('records exactly one unmetered event when no result event arrives', async () => {
    const ledger = new UsageLedger('exec-usage-noresult', makeTmp('exec-usage-noresult'));
    try {
      streamRun([{ type: 'system', session_id: 'session-silent' }]);
      await execute(ledger);
      const summary = ledger.summary();
      expect(summary.unmeteredCount).toBe(1);
      expect(summary.qwenSessionCount).toBe(0);
      expect(summary.observedTotalTokens).toBe(0);
    } finally { ledger.close(); }
  });

  it('records an unmetered event, not a fabricated session, when the result event lacks a session id', async () => {
    const ledger = new UsageLedger('exec-usage-nosession', makeTmp('exec-usage-nosession'));
    try {
      streamRun([{ type: 'result', usage: { total_tokens: 9 } }]);
      await execute(ledger);
      const summary = ledger.summary();
      expect(summary.unmeteredCount).toBe(1);
      expect(summary.qwenSessionCount).toBe(0);
      expect(summary.observedTotalTokens).toBe(0);
    } finally { ledger.close(); }
  });

  it('meters a result event under the stream-established session id when the event itself omits session_id', async () => {
    const ledger = new UsageLedger('exec-usage-inherited-session', makeTmp('exec-usage-inherited-session'));
    try {
      // An earlier stream event established the session identity; the result
      // event omits it. The snapshot is metered under that observed session
      // (max-per-session), not marked unmetered.
      streamRun([
        { type: 'system', session_id: 'session-established' },
        { type: 'result', usage: { total_tokens: 18 } },
      ]);
      await execute(ledger);
      expect(ledger.summary()).toMatchObject({
        qwenSessionCount: 1,
        observedTotalTokens: 18,
        unmeteredCount: 0,
      });
    } finally { ledger.close(); }
  });

  it('marks a result event with a known session but missing usage as unmetered, never zero', async () => {
    const ledger = new UsageLedger('exec-usage-nousage', makeTmp('exec-usage-nousage'));
    try {
      streamRun([{ type: 'result', session_id: 'session-nousage' }]);
      await execute(ledger);
      const summary = ledger.summary();
      expect(summary.unmeteredCount).toBe(1);
      expect(summary.qwenSessionCount).toBe(0);
      expect(summary.observedTotalTokens).toBe(0);
    } finally { ledger.close(); }
  });

  it('keeps one session maximum across continuation runs and a ledger restart without double counting', async () => {
    const stateDir = makeTmp('exec-usage-restart');
    const first = new UsageLedger('exec-usage-restart', stateDir);
    try {
      streamRun([{ type: 'result', session_id: 'session-cont', usage: { total_tokens: 30 } }]);
      await execute(first);
      expect(first.summary().observedTotalTokens).toBe(30);
    } finally { first.close(); }
    // Continuation run in a restarted process on the same state directory: a
    // lower cumulative snapshot never lowers or re-adds the observed total,
    // and the regression is flagged as an anomaly rather than ignored.
    const reopened = new UsageLedger('exec-usage-restart', stateDir);
    try {
      streamRun([{ type: 'result', session_id: 'session-cont', usage: { total_tokens: 20 } }]);
      await execute(reopened);
      const summary = reopened.summary();
      expect(summary).toMatchObject({ qwenSessionCount: 1, observedTotalTokens: 30, unmeteredCount: 0, anomalyCount: 1 });
    } finally { reopened.close(); }
  });
});
