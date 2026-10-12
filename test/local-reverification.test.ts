import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultProjectConfig } from '../src/core/config.js';
import { PersistentTaskStore } from '../src/core/persistent-store.js';
import type { RemoteIssue, RemotePullRequest, GitHubControl, CheckSummary } from '../src/github/control-plane.js';
import type { TaskSpec } from '../src/core/types.js';
import { renderNormalizedBody, type TaskNormalizer } from '../src/intake/normalizer.js';
import type { QwenCodeRunInput, QwenCodeRunResult, QwenExecutor } from '../src/qwen/qwen-code-executor.js';
import { UniversalRewardEngine, type RewardEvaluator } from '../src/rewards/engine.js';
import { ExecutionEvaluator } from '../src/rewards/evaluators.js';
import { GateRunner } from '../src/rewards/gates.js';
import { HarnessSupervisor } from '../src/supervisor.js';
import { GitWorkspace } from '../src/git/git-workspace.js';
import { runProcess } from '../src/runtime/safe-process.js';
import { createGitFixture } from './fixtures/git.js';
import { makeTmp, silentLogger } from './helpers.js';

const fixtures: string[] = [];

class MockQwenExecutor implements QwenExecutor {
  async execute(input: QwenCodeRunInput): Promise<QwenCodeRunResult> {
    input.onSession?.('qwen-session-1');
    writeFileSync(path.join(input.worktree, 'feature.txt'), 'implemented by Qwen\n');
    return {
      sessionId: 'qwen-session-1',
      workflowRunId: 'workflow-1',
      summary: 'add verified feature',
      goalState: 'complete',
      goalReason: null,
      needsContinuation: false,
      usage: { output_tokens: 10 },
      durationMs: 5,
    };
  }
}

/**
 * Reproduces the live incident: the implementer finishes a gate receipt,
 * then keeps editing tracked documentation afterwards, and a stale
 * previously-passed receipt is left in the worktree state directory.
 */
class StaleReceiptQwenExecutor implements QwenExecutor {
  async execute(input: QwenCodeRunInput): Promise<QwenCodeRunResult> {
    input.onSession?.('qwen-session-stale');
    writeFileSync(path.join(input.worktree, 'feature.txt'), 'implemented by Qwen\n');
    // Tracked documentation edit landed after the earlier receipt finished.
    mkdirSync(path.join(input.worktree, 'docs', 'blockers'), { recursive: true });
    writeFileSync(
      path.join(input.worktree, 'docs', 'blockers', 'incident.md'),
      '# Late documentation edit after the gate receipt finished\n',
    );
    // A previously-passed receipt that predates the documentation edit.
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: input.worktree, encoding: 'utf8' }).trim();
    const state = path.join(input.worktree, '.qwen-harness', 'state');
    mkdirSync(state, { recursive: true });
    const finished = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(path.join(state, 'gate-receipt.json'), JSON.stringify({
      version: 1,
      runId: 'stale-run-id',
      startedAt: new Date(Date.now() - 90_000).toISOString(),
      finishedAt: finished,
      worktree: realpathSync(input.worktree),
      cwd: realpathSync(input.worktree),
      status: 'passed',
      head,
      configHash: 'a'.repeat(64),
      contentHash: 'b'.repeat(64),
      finalContentHash: 'b'.repeat(64),
      gates: [{ id: 'unit', status: 'passed', applicable: true, required: true, exitCode: 0 }],
    }));
    return {
      sessionId: 'qwen-session-stale',
      workflowRunId: null,
      summary: 'candidate with a stale receipt and a late doc edit',
      goalState: 'complete',
      goalReason: null,
      needsContinuation: false,
      usage: {},
      durationMs: 5,
    };
  }
}

class MockNormalizer implements TaskNormalizer {
  async normalize(
    issue: RemoteIssue,
    sourceKind: TaskSpec['source']['kind'] = 'user',
  ): Promise<{ title: string; body: string; spec: TaskSpec }> {
    const spec: TaskSpec = {
      goal: 'Create feature.txt with the Qwen implementation marker.',
      source: { kind: sourceKind, url: issue.url, author: issue.author },
      acceptanceCriteria: ['feature.txt exists and check.mjs exits successfully'],
      constraints: ['Do not change harness governance'],
      requiredGateIds: ['unit'],
      rewardCriterionIds: ['execution', 'acceptance', 'independent-review'],
      risk: 'low',
      dependencies: [],
      rollback: 'Revert the feature commit.',
      technologyDecisions: [],
      deploymentDecisions: [],
    };
    return { title: 'Add verified feature', body: renderNormalizedBody(issue, spec), spec };
  }
}

class PassingEvaluator implements RewardEvaluator {
  constructor(readonly modality: 'rubric' | 'agentic') {}
  async evaluate(): Promise<{ score: number; confidence: number; reason: string; evidence: [] }> {
    return { score: 1, confidence: 1, reason: 'independently verified', evidence: [] };
  }
}

class MockGitHub implements GitHubControl {
  readonly repoSlug = 'owner/fixture';
  readonly issues = new Map<number, RemoteIssue>();
  readonly comments: Array<{ number: number; body: string }> = [];
  readonly prs = new Map<number, RemotePullRequest>();
  readonly checks: string[] = [];
  checkSummary: CheckSummary = { complete: true, successful: true, pending: [], failed: [] };
  private nextIssue = 2;

  constructor() {
    this.issues.set(1, {
      number: 1,
      title: 'Please add the feature',
      body: 'A user request that must be normalized first.',
      labels: ['harness:accept', 'harness:community'],
      author: 'user',
      url: 'https://github.test/issues/1',
    });
  }

  async currentUser(): Promise<string> { return 'bot'; }
  async listOpenIssues(): Promise<RemoteIssue[]> { return [...this.issues.values()]; }
  async getIssue(number: number): Promise<RemoteIssue> { return this.issues.get(number) as RemoteIssue; }
  async createIssue(input: { title: string; body: string; labels: string[] }): Promise<RemoteIssue> {
    const issue = { number: this.nextIssue++, title: input.title, body: input.body, labels: input.labels, author: 'bot', url: `https://github.test/issues/${this.nextIssue - 1}` };
    this.issues.set(issue.number, issue);
    return issue;
  }
  async updateIssue(number: number, input: { title?: string; body?: string; state?: 'open' | 'closed' }): Promise<RemoteIssue> {
    const issue = this.issues.get(number) as RemoteIssue;
    if (input.title !== undefined) issue.title = input.title;
    if (input.body !== undefined) issue.body = input.body;
    return issue;
  }
  async comment(number: number, body: string): Promise<void> { this.comments.push({ number, body }); }
  async addLabels(number: number, labels: string[]): Promise<void> { (this.issues.get(number) as RemoteIssue).labels.push(...labels); }
  async removeLabel(): Promise<void> { /* unused */ }
  async findPullRequestByHead(): Promise<RemotePullRequest | null> { return null; }
  async createPullRequest(input: { title: string; body: string; head: string; headSha: string; base: string }): Promise<RemotePullRequest> {
    const pr: RemotePullRequest = { number: 1, title: input.title, head: input.head, headSha: input.headSha, mergeCommitSha: null, base: input.base, url: 'https://github.test/pull/1', state: 'open', merged: false, mergeable: true };
    this.prs.set(1, pr);
    return pr;
  }
  async getPullRequest(number: number): Promise<RemotePullRequest> { return this.prs.get(number) as RemotePullRequest; }
  async checksForRef(): Promise<CheckSummary> { return this.checkSummary; }
  async publishCheck(input: { name: string; sha: string }): Promise<void> { this.checks.push(input.name); }
  async mergePullRequest(number: number, expectedHeadSha: string): Promise<{ merged: boolean; sha: string; message: string }> {
    const pr = this.prs.get(number) as RemotePullRequest;
    pr.merged = true;
    pr.state = 'closed';
    pr.mergeCommitSha = expectedHeadSha;
    return { merged: true, sha: expectedHeadSha, message: 'merged' };
  }
}

async function git(args: string[], cwd: string): Promise<string> {
  const result = await runProcess({ command: 'git', args, cwd, timeoutMs: 20_000 });
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.trim();
}

function unitGate(extra: Partial<{ command: string; args: string[] }> = {}) {
  return {
    id: 'unit',
    kind: 'unit' as const,
    command: extra.command ?? process.execPath,
    args: extra.args ?? ['check.mjs'],
    required: true,
    timeoutMs: 10_000,
  };
}

describe('deterministic local gate re-verification before commitCandidate', () => {
  it('replaces a stale previously-passed receipt with fresh final-candidate evidence', async () => {
    const { repo, remote } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    config.intake.trustedAuthors.push('bot');
    config.gates = [unitGate()];
    const state = makeTmp('local-reverify-stale-state');
    const store = new PersistentTaskStore('local-reverify-stale', state);
    try {
      const github = new MockGitHub();
      const supervisor = new HarnessSupervisor(
        config, store, github, new GitWorkspace(repo, state, config), new StaleReceiptQwenExecutor(),
        new MockNormalizer(), new GateRunner(),
        new UniversalRewardEngine([new ExecutionEvaluator(), new PassingEvaluator('rubric'), new PassingEvaluator('agentic')]),
        silentLogger, 'worker-local-reverify-stale',
      );
      await supervisor.tick();

      const task = store.findByIssue(2)!;
      expect(task.state).toBe('done');
      expect(github.prs.size).toBe(1);
      const events = store.listEvents('task.local_reverification');
      expect(events).toHaveLength(1);
      expect(events[0]!.taskId).toBe(task.id);
      expect(events[0]!.payload).toMatchObject({ runId: expect.any(String), status: 'passed', gates: 1 });
      expect(events[0]!.payload.runId).not.toBe('stale-run-id');
      // Fresh receipt evidence describes the exact pre-commit candidate state.
      expect(events[0]!.payload.head).toBe(task.baseSha);

      // The late tracked doc edit is part of the committed candidate (it was
      // covered by the fresh gate run), and no harness gate artifacts ride in.
      const committed = await git(['diff', '--name-only', `${task.baseSha}..${task.commitSha as string}`], repo);
      expect(committed.split('\n').sort()).toEqual(['docs/blockers/incident.md', 'feature.txt']);
      const harnessInCommit = await git(
        ['ls-tree', '-r', '--name-only', task.commitSha as string, '.qwen-harness'], repo,
      );
      expect(harnessInCommit).toBe('');
      expect(await git(['ls-remote', '--heads', remote], repo)).toContain(task.branch as string);
    } finally {
      store.close();
    }
  }, 30_000);

  it('blocks commit, push, and PR when a configured required gate fails', async () => {
    const { repo, remote } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    config.intake.trustedAuthors.push('bot');
    config.gates = [unitGate({ args: ['-e', 'process.exit(3)'] })];
    const state = makeTmp('local-reverify-fail-state');
    const store = new PersistentTaskStore('local-reverify-fail', state);
    try {
      const github = new MockGitHub();
      const supervisor = new HarnessSupervisor(
        config, store, github, new GitWorkspace(repo, state, config), new MockQwenExecutor(),
        new MockNormalizer(), new GateRunner(),
        new UniversalRewardEngine([new ExecutionEvaluator(), new PassingEvaluator('rubric'), new PassingEvaluator('agentic')]),
        silentLogger, 'worker-local-reverify-fail',
      );
      await supervisor.tick();

      const task = store.findByIssue(2)!;
      expect(task.state).toBe('ready');
      expect(task.attempts).toBe(1);
      expect(task.lastError).toContain('Local gate re-verification failed');
      expect(task.lastError).toContain('immutable gate runner exited 3');
      expect(task.lastError).toContain('FAIL unit');
      expect(github.prs.size).toBe(0);
      expect(store.listEvents('task.local_reverification')).toHaveLength(0);
      expect(store.listEvents('task.candidate_ready')).toHaveLength(0);
      // commitCandidate never ran: the worktree HEAD is still the saved base
      // and nothing was pushed.
      expect(await git(['rev-parse', 'HEAD'], task.worktreePath as string)).toBe(task.baseSha);
      expect(await git(['ls-remote', '--heads', remote], repo)).not.toContain(task.branch as string);
      // No re-verification artifacts linger for the next attempt.
      expect(existsSync(path.join(task.worktreePath as string, '.qwen-harness', 'project.yml'))).toBe(false);
      expect(existsSync(path.join(task.worktreePath as string, '.qwen-harness', 'state', 'gate-receipt.json'))).toBe(false);
    } finally {
      store.close();
    }
  }, 30_000);

  it('adds no product edit of its own on the passing path', async () => {
    const { repo } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    config.intake.trustedAuthors.push('bot');
    config.gates = [unitGate()];
    const state = makeTmp('local-reverify-clean-state');
    const store = new PersistentTaskStore('local-reverify-clean', state);
    try {
      const github = new MockGitHub();
      const supervisor = new HarnessSupervisor(
        config, store, github, new GitWorkspace(repo, state, config), new MockQwenExecutor(),
        new MockNormalizer(), new GateRunner(),
        new UniversalRewardEngine([new ExecutionEvaluator(), new PassingEvaluator('rubric'), new PassingEvaluator('agentic')]),
        silentLogger, 'worker-local-reverify-clean',
      );
      await supervisor.tick();

      const task = store.findByIssue(2)!;
      expect(task.state).toBe('done');
      // Exactly the Qwen-authored file is committed; the deterministic
      // re-verification itself contributes nothing to the candidate.
      const committed = await git(['diff', '--name-only', `${task.baseSha}..${task.commitSha as string}`], repo);
      expect(committed.split('\n')).toEqual(['feature.txt']);
      const harnessInCommit = await git(
        ['ls-tree', '-r', '--name-only', task.commitSha as string, '.qwen-harness'], repo,
      );
      expect(harnessInCommit).toBe('');
    } finally {
      store.close();
    }
  }, 30_000);
});
