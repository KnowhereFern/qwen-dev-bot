import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultProjectConfig } from '../src/core/config.js';
import type { TaskRecord } from '../src/core/types.js';
import { QwenAgenticEvaluator } from '../src/rewards/evaluators.js';
import type { RewardContext } from '../src/rewards/engine.js';
import { runProcess } from '../src/runtime/safe-process.js';
import { makeTmp } from './helpers.js';

vi.mock('../src/runtime/safe-process.js', () => ({ runProcess: vi.fn() }));
const verdict = { score: 1, confidence: 1, reason: 'verified', blockingFindings: [] };
const terminal = (result: unknown) => `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result })}\n`;

function fixture() {
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
  return () => new QwenAgenticEvaluator().evaluate(criterion, context);
}

function output(chunks: string[], exitCode = 0, timedOut = false) {
  vi.mocked(runProcess).mockImplementation(async (options) => {
    for (const chunk of chunks) options.onStdout?.(chunk);
    return {
      command: options.command, args: options.args ?? [], cwd: options.cwd,
      exitCode, timedOut, aborted: false, durationMs: 1,
      // The capped diagnostic capture is deliberately not a parseable verdict.
      stdout: '{"truncated-diagnostic', stderr: '',
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
