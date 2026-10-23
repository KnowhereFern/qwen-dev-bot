import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultProjectConfig } from '../src/core/config.js';
import type { TaskRecord } from '../src/core/types.js';
import { UsageBudgetActiveError, UsageLedger, budgetStatus } from '../src/core/usage-ledger.js';
import { QwenAgenticEvaluator } from '../src/rewards/evaluators.js';
import type { RewardContext } from '../src/rewards/engine.js';
import { QuotaHoldActiveError, type QuotaHoldController, type ProviderRoute } from '../src/qwen/quota-hold.js';
import type { UsageBudgetController, UsageBudgetStatus } from '../src/core/usage-ledger.js';
import { runProcess } from '../src/runtime/safe-process.js';
import { makeTmp } from './helpers.js';

vi.mock('../src/runtime/safe-process.js', () => ({ runProcess: vi.fn() }));
const verdict = { score: 1, confidence: 1, reason: 'verified', blockingFindings: [] };
const terminal = (result: unknown) => `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result })}\n`;

function fixture(deps: { quotaHold?: QuotaHoldController; usageLedger?: UsageLedger; usageBudget?: UsageBudgetController } = {}) {
  const root = makeTmp('agentic-review');
  const config = defaultProjectConfig(root, 'fixture', 'owner/repo');
  const task: TaskRecord = {
    id: 'task', projectId: 'project', issueNumber: 1, title: 'task', body: '', labels: [], author: 'bot',
    state: 'verifying', spec: null, priority: 0, attempts: 0, identicalFailures: 0,
    lastFailureFingerprint: null, maxAttempts: 5, leaseOwner: 'worker', leaseExpiresAt: 1,
    baseSha: 'base', branch: 'branch', worktreePath: root, commitSha: 'commit', qwenSessionId: null,
    qwenWorkflowRunId: null, prNumber: null, prUrl: null, mergeSha: null, rewardRunId: null,
    lastError: null, createdAt: 1, updatedAt: 1, version: 1,
  };
  const context: RewardContext = { config, task, worktree: root, commitSha: 'commit', changedFiles: [], diff: '', gateResults: [] };
  const criterion = config.rewards.criteria.find((entry) => entry.modality === 'agentic')!;
  const evaluator = new QwenAgenticEvaluator(null, deps.quotaHold ?? null, deps.usageLedger ?? null, deps.usageBudget ?? null);
  return () => evaluator.evaluate(criterion, context);
}

function output(chunks: string[], exitCode = 0, timedOut = false, stderr = '') {
  vi.mocked(runProcess).mockImplementation(async (options) => {
    for (const chunk of chunks) options.onStdout?.(chunk);
    return {
      command: options.command, args: options.args ?? [], cwd: options.cwd,
      exitCode, timedOut, aborted: false, durationMs: 1,
      // The capped diagnostic capture is deliberately not a parseable verdict.
      stdout: '{"truncated-diagnostic', stderr,
    };
  });
}

describe('QwenAgenticEvaluator streamed verdict', () => {
  beforeEach(() => { vi.mocked(runProcess).mockReset(); });

  it('uses the terminal event after large output instead of the captured transcript', async () => {
    const progress = `${JSON.stringify({ type: 'assistant', content: 'x'.repeat(2048) })}\n`;
    output([...Array.from({ length: 100 }, () => progress), terminal(JSON.stringify(verdict))]);
    expect(await fixture()()).toMatchObject(verdict);
    const options = vi.mocked(runProcess).mock.calls[0]![0];
    expect(options.args?.[options.args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(options.args?.[options.args.indexOf('--approval-mode') + 1]).toBe('plan');
    expect(options.args).toContain('--sandbox');
    expect(options.args).toContain('--json-schema');
    expect(options.args).not.toContain('--allowed-tools');
    const prompt = options.args?.[options.args.indexOf('--prompt') + 1] ?? '';
    expect(prompt).toContain(`Your working directory is the candidate worktree: ${options.cwd}`);
    expect(prompt).toContain('Use relative paths from this directory for every read, grep, and glob.');
    const excluded = options.args?.slice(options.args.indexOf('--exclude-tools') + 1, options.args.indexOf('--exclude-tools') + 3).join(',') ?? '';
    for (const name of ['agent', 'workflow', 'run_shell_command', 'write_file', 'notebook_edit', 'web_fetch', 'web_search', 'exit_plan_mode']) {
      expect(excluded).toContain(name);
    }
  });

  it('accepts object verdicts', async () => {
    output([terminal(verdict)]);
    expect(await fixture()()).toMatchObject(verdict);
  });

  it.each([
    ['missing terminal', '{"type":"assistant"}\n'],
    ['truncated terminal', terminal(verdict).slice(0, -10)],
    ['non-JSON verdict', terminal('prefix ' + JSON.stringify(verdict))],
    ['out-of-range score', terminal({ ...verdict, score: 100 })],
    ['invalid confidence', terminal({ ...verdict, confidence: -1 })],
    ['invalid findings', terminal({ ...verdict, blockingFindings: [{}] })],
    ['scalar payload', terminal(1)],
  ])('rejects %s', async (_name, stream) => {
    output([stream]);
    await expect(fixture()()).rejects.toThrow();
  });

  it.each([[1, false], [0, true]])('rejects failed process receipt %s/%s even with a verdict', async (exitCode, timedOut) => {
    output([terminal(verdict)], exitCode as number, timedOut as boolean);
    await expect(fixture()()).rejects.toThrow('Qwen independent review failed');
  });
});

describe('QwenAgenticEvaluator quota hold and budget gate', () => {
  beforeEach(() => { vi.mocked(runProcess).mockReset(); });

  it('blocks before spawn when the shared provider route is held', async () => {
    output([terminal(verdict)]);
    const quotaHold: QuotaHoldController = { heldUntil: () => Date.now() + 60_000, applyHold: () => 0 };
    await expect(fixture({ quotaHold })()).rejects.toMatchObject({ name: 'QuotaHoldActiveError' });
    expect(runProcess).not.toHaveBeenCalled();
  });

  it('blocks before spawn when the observed-token budget is exhausted', async () => {
    output([terminal(verdict)]);
    const ledger = new UsageLedger('project', makeTmp('agentic-budget'));
    ledger.recordQwenSessionSnapshot('session', { total_tokens: 100 });
    const status: UsageBudgetStatus = budgetStatus(ledger.summary(), 100);
    const usageBudget: UsageBudgetController = { status: () => status };
    await expect(fixture({ usageBudget })()).rejects.toMatchObject({ name: 'UsageBudgetActiveError' });
    expect(runProcess).not.toHaveBeenCalled();
    ledger.close();
  });
});

describe('QwenAgenticEvaluator usage metering', () => {
  beforeEach(() => { vi.mocked(runProcess).mockReset(); });

  function ledgerFixture() {
    const ledger = new UsageLedger('project', makeTmp('agentic-usage'));
    return { ledger, run: fixture({ usageLedger: ledger }) };
  }

  it('records cumulative usage under the result event session id on success', async () => {
    const { ledger, run } = ledgerFixture();
    output([`{"type":"system","subtype":"init","session_id":"other"}\n`, `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'session-1', usage: { total_tokens: 42 }, result: verdict })}\n`]);
    await expect(run()).resolves.toMatchObject(verdict);
    expect(ledger.summary()).toMatchObject({ observedTotalTokens: 42, qwenSessionCount: 1, unmeteredCount: 0 });
    ledger.close();
  });

  it('meters under the stream-established session id when the result event omits it', async () => {
    const { ledger, run } = ledgerFixture();
    output([`{"type":"system","subtype":"init","session_id":"stream-session"}\n`, `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 3, output_tokens: 4 }, result: verdict })}\n`]);
    await expect(run()).resolves.toMatchObject(verdict);
    expect(ledger.summary()).toMatchObject({ observedTotalTokens: 7, qwenSessionCount: 1, unmeteredCount: 0 });
    ledger.close();
  });

  it('marks a missing usage payload unmetered, never zero', async () => {
    const { ledger, run } = ledgerFixture();
    output([`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'session-2', result: verdict })}\n`]);
    await expect(run()).resolves.toMatchObject(verdict);
    expect(ledger.summary()).toMatchObject({ observedTotalTokens: 0, qwenSessionCount: 0, unmeteredCount: 1 });
    ledger.close();
  });

  it('records streamed usage even when the process later fails', async () => {
    const { ledger, run } = ledgerFixture();
    output([`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'session-3', usage: { total_tokens: 9 }, result: verdict })}\n`], 1);
    await expect(run()).rejects.toThrow('Qwen independent review failed');
    expect(ledger.summary()).toMatchObject({ observedTotalTokens: 9, qwenSessionCount: 1, unmeteredCount: 0 });
    ledger.close();
  });

  it('marks a run with no result event unmetered even on failure', async () => {
    const { ledger, run } = ledgerFixture();
    output(['{"type":"assistant","content":"working"}\n'], 1);
    await expect(run()).rejects.toThrow('Qwen independent review failed');
    expect(ledger.summary()).toMatchObject({ observedTotalTokens: 0, qwenSessionCount: 0, unmeteredCount: 1 });
    ledger.close();
  });
});

describe('QwenAgenticEvaluator monthly quota hold from reviewer failure', () => {
  beforeEach(() => { vi.mocked(runProcess).mockReset(); });

  const monthlyReason = 'Your 1-month quota is exhausted; reset at 2026-11-01 00:00:00 UTC';

  it('applies the global hold for a confirmed monthly reason in bounded stderr', async () => {
    output([''], 1, false, `provider: ${monthlyReason}`);
    const applied: Array<{ route: ProviderRoute; resetAt: number | null; kind: string }> = [];
    const quotaHold: QuotaHoldController = {
      heldUntil: () => null,
      applyHold: (route, input) => {
        applied.push({ route, resetAt: input.resetAt ?? null, kind: input.kind });
        return Date.parse('2026-11-01T00:00:00Z') + 5 * 60_000;
      },
    };
    await expect(fixture({ quotaHold })()).rejects.toBeInstanceOf(QuotaHoldActiveError);
    expect(runProcess).toHaveBeenCalledTimes(1);
    expect(applied).toHaveLength(1);
    expect(applied[0]!.kind).toBe('qwen_code_quota');
    expect(applied[0]!.resetAt).toBe(Date.parse('2026-11-01T00:00:00Z'));
  });

  it('applies the hold from a bounded structured result-event reason', async () => {
    output([`${JSON.stringify({ type: 'result', subtype: 'error', is_error: true, reason: monthlyReason })}\n`], 1);
    let held = false;
    const quotaHold: QuotaHoldController = { heldUntil: () => (held ? Date.now() + 60_000 : null), applyHold: () => { held = true; return Date.now() + 60_000; } };
    await expect(fixture({ quotaHold })()).rejects.toMatchObject({ name: 'QuotaHoldActiveError' });
    expect(held).toBe(true);
  });

  it('treats unrelated overload wording as a process failure without a global hold', async () => {
    output([''], 1, false, 'Requests are rate limited due to overload, please retry later');
    const quotaHold: QuotaHoldController = { heldUntil: () => null, applyHold: () => { throw new Error('hold must not be applied'); } };
    await expect(fixture({ quotaHold })()).rejects.toThrow('Qwen independent review failed');
    await expect(fixture({ quotaHold })()).rejects.not.toMatchObject({ name: 'QuotaHoldActiveError' });
  });
});
