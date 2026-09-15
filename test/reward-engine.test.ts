import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultProjectConfig } from '../src/core/config.js';
import type { GateResult, TaskRecord } from '../src/core/types.js';
import { UniversalRewardEngine, type EvaluatorResult, type RewardContext, type RewardEvaluator } from '../src/rewards/engine.js';
import { ExecutionEvaluator } from '../src/rewards/evaluators.js';
import { GateRunner } from '../src/rewards/gates.js';
import { makeTmp } from './helpers.js';

class PassingEvaluator implements RewardEvaluator {
  constructor(readonly modality: 'rubric' | 'agentic') {}
  async evaluate(): Promise<EvaluatorResult> {
    return { score: 1, confidence: 1, reason: 'verified', evidence: [] };
  }
}

describe('universal runtime rewards', () => {
  it('never lets soft scores compensate for a hard execution failure', async () => {
    const root = makeTmp('reward');
    const config = defaultProjectConfig(root, 'fixture', 'owner/repo');
    const failedGate = gate(false);
    const engine = new UniversalRewardEngine([
      new ExecutionEvaluator(),
      new PassingEvaluator('rubric'),
      new PassingEvaluator('agentic'),
    ]);
    const scorecard = await engine.evaluate(context(config, root, [failedGate]));
    expect(scorecard.aggregateScore).toBe(1);
    expect(scorecard.hardGatePass).toBe(false);
    expect(scorecard.passed).toBe(false);
    expect(scorecard.blockingReasons.some((reason) => reason.includes('execution'))).toBe(true);
  });

  it('passes when hard gates and every critical Qwen criterion pass', async () => {
    const root = makeTmp('reward-pass');
    const config = defaultProjectConfig(root, 'fixture', 'owner/repo');
    const engine = new UniversalRewardEngine([
      new ExecutionEvaluator(),
      new PassingEvaluator('rubric'),
      new PassingEvaluator('agentic'),
    ]);
    const scorecard = await engine.evaluate(context(config, root, [gate(true)]));
    expect(scorecard.hardGatePass).toBe(true);
    expect(scorecard.aggregateScore).toBe(1);
    expect(scorecard.passed).toBe(true);
  });

  it('stops before running evaluators after worker shutdown', async () => {
    const root = makeTmp('reward-aborted');
    const config = defaultProjectConfig(root, 'fixture', 'owner/repo');
    const controller = new AbortController();
    controller.abort();
    const engine = new UniversalRewardEngine([
      new ExecutionEvaluator(),
      new PassingEvaluator('rubric'),
      new PassingEvaluator('agentic'),
    ]);
    await expect(
      engine.evaluate({ ...context(config, root, [gate(true)]), signal: controller.signal }),
    ).rejects.toThrow('worker shutdown');
  });

  it('fails the built-in security gate on a changed credential', async () => {
    const root = makeTmp('reward-secret');
    const providerKey = `sk-${'abcdefghijklmnopqrstuvwxyz123456'}`;
    writeFileSync(path.join(root, 'leak.txt'), `OPENAI_API_KEY=${providerKey}\n`);
    const result = await new GateRunner().runAll([], root, ['leak.txt']);
    expect(result[0]?.id).toBe('harness-security');
    expect(result[0]?.ok).toBe(false);
    expect(result[0]?.stderr).toContain('possible cloud/API key');
  });

  it('fails the built-in security gate on an active nonstandard worker secret', async () => {
    const root = makeTmp('reward-environment-secret');
    const name = 'QWEN_HARNESS_GATE_TEST_SECRET';
    const prior = process.env[name];
    process.env[name] = 'nonstandard-worker-credential-value';
    try {
      writeFileSync(path.join(root, 'leak.txt'), `credential=${process.env[name]}\n`);
      const result = await new GateRunner().runAll([], root, ['leak.txt']);
      expect(result[0]?.ok).toBe(false);
      expect(result[0]?.stderr).toContain('contains a secret from the worker environment');
      expect(result[0]?.stderr).not.toContain(process.env[name]);
    } finally {
      if (prior === undefined) delete process.env[name];
      else process.env[name] = prior;
    }
  });
});

function gate(ok: boolean): GateResult {
  return {
    id: 'unit',
    kind: 'unit',
    required: true,
    applicable: true,
    ok,
    exitCode: ok ? 0 : 1,
    stdout: ok ? 'passed' : '',
    stderr: ok ? '' : 'failed',
    durationMs: 1,
    command: ['npm', 'test'],
    evidenceHash: 'evidence',
  };
}

function context(config: ReturnType<typeof defaultProjectConfig>, root: string, gates: GateResult[]): RewardContext {
  return {
    config,
    task: {
      id: 'task-1', projectId: 'project', issueNumber: 1, title: 'task', body: '', labels: [], author: 'bot',
      state: 'verifying', spec: null, priority: 0, attempts: 0, identicalFailures: 0,
      lastFailureFingerprint: null, maxAttempts: 5, leaseOwner: 'worker', leaseExpiresAt: 1,
      baseSha: 'base', branch: 'branch', worktreePath: root, commitSha: 'commit', qwenSessionId: null,
      qwenWorkflowRunId: null, prNumber: null, prUrl: null, mergeSha: null, rewardRunId: null,
      lastError: null, createdAt: 1, updatedAt: 1, version: 1,
    } satisfies TaskRecord,
    worktree: root,
    commitSha: 'commit',
    changedFiles: [],
    diff: '',
    gateResults: gates,
  };
}
