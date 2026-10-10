import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { defaultProjectConfig } from '../src/core/config.js';
import { PersistentTaskStore } from '../src/core/persistent-store.js';
import type { GateDefinition, GateResult, ProjectConfig, RewardCriterionConfig, TaskSpec } from '../src/core/types.js';
import { GitWorkspace } from '../src/git/git-workspace.js';
import type {
  CheckSummary,
  GitHubControl,
  RemoteIssue,
  RemotePullRequest,
} from '../src/github/control-plane.js';
import { parseNormalizedSpec, renderNormalizedBody, type TaskNormalizer } from '../src/intake/normalizer.js';
import { PortfolioCoordinator } from '../src/portfolio/coordinator.js';
import { PortfolioPlanner, type PortfolioPlanningModel } from '../src/portfolio/planner.js';
import { ProgramController } from '../src/program/controller.js';
import { RepositoryAssessor } from '../src/program/repository-assessor.js';
import { EvolutionSignalCollector } from '../src/evolution/signals.js';
import { StagingDeploymentController } from '../src/deployment/controller.js';
import { Logger } from '../src/logger.js';
import type { QwenCodeRunInput, QwenCodeRunResult, QwenExecutor } from '../src/qwen/qwen-code-executor.js';
import { UniversalRewardEngine, type EvaluatorResult, type RewardEvaluator } from '../src/rewards/engine.js';
import { ExecutionEvaluator } from '../src/rewards/evaluators.js';
import { GateRunner } from '../src/rewards/gates.js';
import { HarnessSupervisor } from '../src/supervisor.js';
import { runProcess } from '../src/runtime/safe-process.js';
import { createGitFixture } from './fixtures/git.js';
import { makeTmp, silentLogger } from './helpers.js';

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

class ReadOnlyQwenExecutor implements QwenExecutor {
  async execute(input: QwenCodeRunInput): Promise<QwenCodeRunResult> {
    input.onSession?.('read-only-session');
    return {
      sessionId: 'read-only-session', workflowRunId: null, summary: 'verified existing feature',
      goalState: 'complete', goalReason: null, needsContinuation: false, usage: {}, durationMs: 1,
    };
  }
}

class BlockingQwenExecutor implements QwenExecutor {
  async execute(input: QwenCodeRunInput): Promise<QwenCodeRunResult> {
    input.onSession?.('qwen-session-interrupted');
    return new Promise<QwenCodeRunResult>((_resolve, reject) => {
      const abort = (): void => reject(new Error('Qwen process aborted'));
      if (input.signal?.aborted) abort();
      else input.signal?.addEventListener('abort', abort, { once: true });
    });
  }
}

class ProviderWaitingQwenExecutor implements QwenExecutor {
  async execute(input: QwenCodeRunInput): Promise<QwenCodeRunResult> {
    input.onSession?.('qwen-session-provider-wait');
    return {
      sessionId: 'qwen-session-provider-wait', workflowRunId: null, summary: 'provider overloaded',
      goalState: 'usage_limited', goalReason: 'provider temporarily overloaded', needsContinuation: true,
      continuationKind: 'provider', usage: {}, durationMs: 1,
    };
  }
}

class BudgetPausedQwenExecutor implements QwenExecutor {
  async execute(input: QwenCodeRunInput): Promise<QwenCodeRunResult> {
    input.onSession?.('qwen-session-budget');
    return {
      sessionId: 'qwen-session-budget', workflowRunId: null, summary: 'turn budget reached',
      goalState: 'paused', goalReason: 'turn budget limit', needsContinuation: true,
      continuationKind: 'budget', usage: {}, durationMs: 1,
      automaticStop: { sessionId: 'qwen-session-budget', workflowRunId: null, kind: 'turn-limit' },
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
  async evaluate(_criterion: RewardCriterionConfig): Promise<EvaluatorResult> {
    return { score: 1, confidence: 1, reason: 'independently verified', evidence: [] };
  }
}

class PostMergeFailingGateRunner extends GateRunner {
  private runs = 0;

  override async runAll(
    definitions: GateDefinition[],
    worktree: string,
    changedFiles: string[],
  ): Promise<GateResult[]> {
    const results = await super.runAll(definitions, worktree, changedFiles);
    this.runs += 1;
    if (this.runs === 2) {
      results.push({
        id: 'postmerge-regression',
        kind: 'custom',
        required: true,
        applicable: true,
        ok: false,
        exitCode: 1,
        stdout: '',
        stderr: 'regression reproduced on the merge commit',
        durationMs: 1,
        command: ['internal:test-postmerge'],
        evidenceHash: 'postmerge-regression',
      });
    }
    return results;
  }
}

class BlockingGateRunner extends GateRunner {
  readonly started: Promise<void>;
  private markStarted!: () => void;

  constructor() {
    super();
    this.started = new Promise((resolve) => {
      this.markStarted = resolve;
    });
  }

  override async runAll(
    _definitions: GateDefinition[],
    _worktree: string,
    _changedFiles: string[],
    signal?: AbortSignal,
  ): Promise<GateResult[]> {
    this.markStarted();
    return new Promise<GateResult[]>((_resolve, reject) => {
      const abort = (): void => reject(new Error('Gate run aborted'));
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  }
}

class MockGitHub implements GitHubControl {
  readonly repoSlug = 'owner/fixture';
  readonly issues = new Map<number, RemoteIssue>();
  readonly comments: Array<{ number: number; body: string }> = [];
  readonly prs = new Map<number, RemotePullRequest>();
  readonly checks: string[] = [];
  readonly closedIssues = new Set<number>();
  closureFailures = 0;
  checkSummary: CheckSummary = { complete: true, successful: true, pending: [], failed: [] };
  onChecks?: () => Promise<void>;
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
  async listOpenIssues(): Promise<RemoteIssue[]> { return [...this.issues.values()].filter((issue) => !this.closedIssues.has(issue.number)); }
  async getIssue(number: number): Promise<RemoteIssue> { return this.issues.get(number) as RemoteIssue; }
  async createIssue(input: { title: string; body: string; labels: string[] }): Promise<RemoteIssue> {
    const issue = { number: this.nextIssue++, title: input.title, body: input.body, labels: input.labels, author: 'bot', url: `https://github.test/issues/${this.nextIssue - 1}` };
    this.issues.set(issue.number, issue);
    return issue;
  }
  async updateIssue(number: number, input: { title?: string; body?: string; state?: 'open' | 'closed' }): Promise<RemoteIssue> {
    if (input.state === 'closed') {
      if (this.closureFailures-- > 0) throw new Error('GitHub temporarily unavailable');
      this.closedIssues.add(number);
    }
    const issue = this.issues.get(number) as RemoteIssue;
    if (input.title !== undefined) issue.title = input.title;
    if (input.body !== undefined) issue.body = input.body;
    return issue;
  }
  async comment(number: number, body: string): Promise<void> { this.comments.push({ number, body }); }
  async addLabels(number: number, labels: string[]): Promise<void> { (this.issues.get(number) as RemoteIssue).labels.push(...labels); }
  async removeLabel(number: number, label: string): Promise<void> { const issue = this.issues.get(number) as RemoteIssue; issue.labels = issue.labels.filter((item) => item !== label); }
  async findPullRequestByHead(branch: string, expectedHeadSha?: string, expectedBase?: string): Promise<RemotePullRequest | null> {
    const candidates = [...this.prs.values()].filter((pr) => pr.head === branch && (!expectedBase || pr.base === expectedBase));
    return candidates.find((pr) => pr.state === 'open') ?? candidates.find((pr) => pr.merged && pr.headSha === expectedHeadSha) ?? null;
  }
  async createPullRequest(input: { title: string; body: string; head: string; headSha: string; base: string }): Promise<RemotePullRequest> {
    const pr: RemotePullRequest = { number: 1, title: input.title, head: input.head, headSha: input.headSha, mergeCommitSha: null, base: input.base, url: 'https://github.test/pull/1', state: 'open', merged: false, mergeable: true };
    this.prs.set(1, pr);
    return pr;
  }
  async getPullRequest(number: number): Promise<RemotePullRequest> { return this.prs.get(number) as RemotePullRequest; }
  async checksForRef(): Promise<CheckSummary> { await this.onChecks?.(); return this.checkSummary; }
  async publishCheck(input: { name: string; sha: string }): Promise<void> { this.checks.push(input.name); }
  async mergePullRequest(number: number, expectedHeadSha: string): Promise<{ merged: boolean; sha: string; message: string }> {
    const pr = this.prs.get(number) as RemotePullRequest;
    pr.merged = true;
    pr.state = 'closed';
    pr.mergeCommitSha = expectedHeadSha;
    return { merged: true, sha: expectedHeadSha, message: 'merged' };
  }
}

class AbortAfterSideEffectGitWorkspace extends GitWorkspace {
  constructor(root: string, state: string, config: ProjectConfig, private readonly abort: () => void) {
    super(root, state, config);
  }

  override async changedFiles(worktree: string): Promise<string[]> {
    const files = await super.changedFiles(worktree);
    if (worktree.includes('verify-postmerge-')) this.abort();
    return files;
  }
}

class PostmergeJournalFaultStore extends PersistentTaskStore {
  private faulted = false;

  override recordEvent(type: string, taskId: string | null, payload: Record<string, unknown>, idempotencyKey?: string) {
    if (type === 'postmerge.verification' && !this.faulted) {
      this.faulted = true;
      throw new Error('event journal offline for post-merge verification');
    }
    return super.recordEvent(type, taskId, payload, idempotencyKey);
  }
}

describe('production supervisor trace', () => {
  it.each(['no-plan', 'draft', 'active-without-approval'] as const)('blocks every execution path until initial program approval: %s', async (scenario) => {
    const root = makeTmp('approval-boundary-root');
    const state = makeTmp('approval-boundary-state');
    const config = defaultProjectConfig(root, 'fixture', 'owner/fixture');
    config.program.enabled = true;
    config.intake.trustedAuthors.push('bot');
    config.intake.autoPromoteSelfRepair = true;
    const store = new PersistentTaskStore('approval-boundary', state);
    const github = new MockGitHub();
    const repair = github.issues.get(1)!;
    repair.author = 'bot';
    repair.labels = ['self-repair', config.intake.approvalLabel];
    const qwen = new MockQwenExecutor();
    const normalizer = new MockNormalizer();
    const execute = vi.spyOn(qwen, 'execute');
    const normalize = vi.spyOn(normalizer, 'normalize');
    try {
      if (scenario !== 'no-plan') {
        const created = await new PortfolioCoordinator(config, store, github).createDraft({
          sourcePath: 'OBJECTIVE.md', content: 'Proposed objective', draft: {
            title: 'Proposal', objective: 'Proposed objective', constraints: [], definitionOfDone: ['Tests pass'],
            technologyDecisions: [], deploymentDecisions: [], stories: [],
          },
        });
        if (scenario === 'active-without-approval') store.savePortfolioPlan({ ...created.plan, status: 'active', approvedAt: null });
      }
      // Recovery, normalized ready work and PR reconciliation cannot grandfather authority.
      store.upsert({ issueNumber: 101, title: 'Previously normalized task', state: 'ready' });
      const pending = store.upsert({ issueNumber: 102, title: 'Existing PR', state: 'pr_open' });
      store.patch(pending.id, { prNumber: 99 });
      const expired = store.upsert({ issueNumber: 103, title: 'Expired implementation', state: 'active' });
      store.patch(expired.id, { leaseOwner: 'old-worker', leaseExpiresAt: 1 });
      const before = store.list();
      const issuesBefore = structuredClone([...github.issues.values()]);
      const listIssues = vi.spyOn(github, 'listOpenIssues');
      const supervisor = new HarnessSupervisor(config, store, github, new GitWorkspace(root, state, config), qwen,
        normalizer, new GateRunner(), new UniversalRewardEngine([]), silentLogger, 'approval-worker');
      expect(await supervisor.syncIntake()).toBe(0);
      expect(await supervisor.tick()).toMatchObject({ action: 'awaiting-program-approval', ingested: 0, recovered: 0, processedTaskId: null });
      expect(execute).not.toHaveBeenCalled();
      expect(normalize).not.toHaveBeenCalled();
      expect(listIssues).not.toHaveBeenCalled();
      expect(store.list()).toEqual(before);
      expect([...github.issues.values()]).toEqual(issuesBefore);
    } finally { store.close(); }
  });

  it.each(['verify', 'implement', 'review-failure', 'gate-failure', 'pending-ci', 'failed-ci', 'stale', 'altered-contract', 'operate', 'verified-operate', 'prepare-operate', 'advance-operate', 'review-failure-operate', 'closure-recovery', 'draft-decoy-operate', 'superseded-decoy-operate', 'ambiguous-operate', 'verify-decoy-operate', 'completion-decoy-operate'] as const)(
    'handles unchanged program work safely: %s', async (scenario) => {
      const { repo } = await createGitFixture();
      writeFileSync(path.join(repo, 'feature.txt'), 'existing implementation\n');
      if (scenario === 'gate-failure') writeFileSync(path.join(repo, 'check.mjs'), 'process.exit(1);\n');
      const git = async (args: string[]) => {
        const result = await runProcess({ command: 'git', args, cwd: repo, timeoutMs: 20_000 });
        expect(result.exitCode, result.stderr).toBe(0);
        return result.stdout.trim();
      };
      await git(['add', '.']);
      await git(['commit', '-m', 'existing feature']);
      await git(['push', 'origin', 'main']);
      let baseSha = await git(['rev-parse', 'HEAD']);
      const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
      config.program.enabled = true;
      config.intake.trustedAuthors.push('bot');
      config.gates = [{ id: 'unit', kind: 'unit', command: 'node', args: ['check.mjs'], required: true, timeoutMs: 10_000 }];
      const operation = ['operate', 'verified-operate', 'prepare-operate', 'advance-operate', 'review-failure-operate',
        'draft-decoy-operate', 'superseded-decoy-operate', 'ambiguous-operate', 'verify-decoy-operate', 'completion-decoy-operate'].includes(scenario);
      config.deployment.staging.enabled = operation;
      config.evolution.enabled = false;
      const state = makeTmp('read-only-state');
      let store = new PersistentTaskStore(`read-only-${scenario}`, state);
      const github = new MockGitHub();
      github.issues.clear();
      if (scenario === 'pending-ci') github.checkSummary = { complete: false, successful: false, pending: ['CI'], failed: [] };
      if (scenario === 'failed-ci') github.checkSummary = { complete: true, successful: false, pending: [], failed: ['CI'] };
      if (scenario === 'closure-recovery') github.closureFailures = 1;
      if (scenario === 'stale') github.onChecks = async () => {
        writeFileSync(path.join(repo, 'another-change.txt'), 'new merged revision\n');
        await git(['add', '.']); await git(['commit', '-m', 'new merged revision']); await git(['push', 'origin', 'main']);
      };
      const coordinator = new PortfolioCoordinator(config, store, github);
      const created = await coordinator.createDraft({ sourcePath: 'OBJECTIVE.md', content: 'Verify the existing feature.', draft: {
        title: 'Existing feature', objective: 'Verify existing behavior', constraints: [], definitionOfDone: ['Independent verification passes'],
        technologyDecisions: [], deploymentDecisions: [], stories: [{
          key: 'S1', title: 'Verify existing feature', goal: 'Verify feature.txt and check.mjs', acceptanceCriteria: ['check.mjs passes'],
          constraints: [], requiredGateIds: ['unit'], rewardCriterionIds: ['execution', 'acceptance', 'independent-review'], risk: 'low',
          workType: scenario === 'implement' ? 'implement' : operation ? 'operate' : 'verify', dependsOn: [],
          rollback: 'No repository change', technologyDecisionIds: [], deploymentDecisionIds: [],
        }],
      } });
      const approved = await coordinator.approve(created.plan.id);
      const issueNumber = approved.stories[0]!.normalizedIssueNumber as number;
      if (scenario === 'verified-operate' || scenario === 'review-failure-operate' ||
          scenario === 'draft-decoy-operate' || scenario === 'superseded-decoy-operate' ||
          scenario === 'completion-decoy-operate') store.saveDeployment({
        id: 'verified-staging', projectId: store.projectId, planId: approved.id, wave: 1, provider: 'railway', commitSha: baseSha,
        previousVerifiedCommitSha: null, externalId: 'provider-deployment', status: 'succeeded', healthUrl: 'https://staging.test/health',
        observedRevision: baseSha, error: null, startedAt: 1, updatedAt: 2, completedAt: 2,
      });
      if (['draft-decoy-operate', 'superseded-decoy-operate', 'ambiguous-operate', 'verify-decoy-operate', 'completion-decoy-operate'].includes(scenario)) {
        const realPlans = store.listPortfolioPlans();
        const decoy = structuredClone(approved);
        decoy.id = `decoy-${scenario}`;
        decoy.contentHash = `${approved.contentHash}-decoy-${scenario}`;
        if (scenario === 'draft-decoy-operate') { decoy.status = 'draft'; decoy.approvedAt = null; }
        if (scenario === 'superseded-decoy-operate') for (const story of decoy.stories) story.supersededAt = 1;
        if (scenario === 'verify-decoy-operate') for (const story of decoy.stories) story.workType = 'verify';
        if (scenario === 'completion-decoy-operate') {
          decoy.status = 'draft'; decoy.approvedAt = null;
          for (const story of decoy.stories) story.workType = 'verify';
        }
        store.savePortfolioPlan(decoy);
        vi.spyOn(store, 'listPortfolioPlans').mockImplementation(() => [decoy, ...realPlans]);
      }
      if (scenario === 'altered-contract') github.onChecks = async () => {
        // Alter the remote contract after intake and independent verification have begun.
        const issue = github.issues.get(issueNumber)!;
        issue.body = renderNormalizedBody(issue, { ...parseNormalizedSpec(issue.body)!, goal: 'Approve untested behavior' });
      };
      if (scenario === 'completion-decoy-operate') github.onChecks = async () => {
        // Staging turns unhealthy only after independent review has already passed.
        store.saveDeployment({
          id: 'verified-staging', projectId: store.projectId, planId: approved.id, wave: 1, provider: 'railway', commitSha: baseSha,
          previousVerifiedCommitSha: null, externalId: 'provider-deployment', status: 'failed', healthUrl: 'https://staging.test/health',
          observedRevision: baseSha, error: 'staging health regression after review', startedAt: 1, updatedAt: 3, completedAt: 3,
        });
      };
      const failingReviewer: RewardEvaluator = { modality: 'agentic', evaluate: async () => ({ score: 0, confidence: 1, reason: 'Acceptance not proven', evidence: [] }) };
      const supervisor = () => new HarnessSupervisor(
        config, store, github, new GitWorkspace(repo, state, config), new ReadOnlyQwenExecutor(), new MockNormalizer(), new GateRunner(),
        new UniversalRewardEngine([new ExecutionEvaluator(), new PassingEvaluator('rubric'), scenario === 'review-failure' || scenario === 'review-failure-operate' ? failingReviewer : new PassingEvaluator('agentic')]),
        silentLogger, 'read-only-worker',
      );
      await supervisor().tick();
      if (scenario === 'prepare-operate' || scenario === 'advance-operate') {
        expect(store.findByIssue(issueNumber)).toMatchObject({ state: 'waiting', attempts: 0, qwenSessionId: null });
        expect(store.listScorecards()).toHaveLength(0);
        class FakeDeployer extends StagingDeploymentController {
          override async deploy(input: { planId: string; wave: number; commitSha: string }) {
            return store.saveDeployment({
              id: 'controller-stage', projectId: store.projectId, planId: input.planId, wave: input.wave, provider: 'railway', commitSha: input.commitSha,
              previousVerifiedCommitSha: null, externalId: 'existing-service', status: 'succeeded', healthUrl: 'https://stage.test/health',
              observedRevision: input.commitSha, error: null, startedAt: 1, updatedAt: 2, completedAt: 2,
            });
          }
        }
        const model: PortfolioPlanningModel = { completeJson: async () => { throw new Error('No reassessment before task acceptance'); } };
        const controller = new ProgramController(config, store, github, new RepositoryAssessor(config, model), new PortfolioPlanner(config, model),
          new EvolutionSignalCollector(config, store, github, model), new FakeDeployer(config, store));
        if (scenario === 'advance-operate') {
          writeFileSync(path.join(repo, 'later-merged.txt'), 'another approved writer finished\n');
          await git(['add', '.']); await git(['commit', '-m', 'later merged work']); await git(['push', 'origin', 'main']);
          baseSha = await git(['rev-parse', 'HEAD']);
          expect((await controller.tick()).action).toBe('idle');
          const stale = store.findByIssue(issueNumber)!;
          // Crash after the owned branch fast-forwards but before the task checkpoint is updated.
          store.recordEvent('task.read_only_base_advance_requested', stale.id, { previousSha: stale.baseSha, commitSha: baseSha });
          await new GitWorkspace(repo, state, config).advanceReadOnlyBase(stale.worktreePath as string, stale.baseSha as string, baseSha);
          writeFileSync(path.join(repo, 'merged-during-restart.txt'), 'another merged revision\n');
          await git(['add', '.']); await git(['commit', '-m', 'merge while restarting']); await git(['push', 'origin', 'main']);
          baseSha = await git(['rev-parse', 'HEAD']);
          store.patch(stale.id, { resumeAfter: Date.now() - 1 });
          await supervisor().tick();
          expect(store.listEvents('task.read_only_base_advanced')).toHaveLength(1);
          expect(store.findByIssue(issueNumber)).toMatchObject({ state: 'waiting', baseSha, commitSha: baseSha, attempts: 0 });
        }
        expect((await controller.tick()).action).toBe('deployed');
        const pending = store.findByIssue(issueNumber)!;
        expect(pending.state).toBe('waiting');
        store.patch(pending.id, { resumeAfter: Date.now() - 1 });
        await supervisor().tick();
        expect(store.listScorecards()[0]?.passed).toBe(true);
      }
      const task = store.findByIssue(issueNumber)!;
      expect(github.prs.size).toBe(0);
      expect(await git(['ls-remote', '--heads', 'origin', task.branch as string])).toBe('');
      if (scenario === 'verify' || scenario === 'verified-operate' || scenario === 'prepare-operate' || scenario === 'advance-operate' ||
          scenario === 'closure-recovery' || scenario === 'draft-decoy-operate' || scenario === 'superseded-decoy-operate') {
        expect(task).toMatchObject({ state: 'done', commitSha: baseSha, mergeSha: baseSha, attempts: 0 });
        expect(store.listEvents('task.read_only_verified')).toHaveLength(1);
        if (scenario === 'closure-recovery') {
          expect(github.closedIssues.has(issueNumber)).toBe(false);
          store.close(); store = new PersistentTaskStore(`read-only-${scenario}`, state);
          await supervisor().tick();
        }
        expect(github.closedIssues.has(issueNumber)).toBe(true);
        expect(store.listEvents('task.read_only_closed')).toHaveLength(1);
      } else if (scenario === 'pending-ci' || scenario === 'operate' || scenario === 'completion-decoy-operate') {
        expect(task).toMatchObject({ state: 'waiting', attempts: 0, waitKind: 'provider' });
        expect(github.closedIssues.has(issueNumber)).toBe(false);
      } else {
        expect(task).toMatchObject({ state: 'ready', attempts: 1 });
        expect(github.closedIssues.has(issueNumber)).toBe(false);
        expect(store.listEvents('task.read_only_verified')).toHaveLength(0);
      }
      if (scenario === 'ambiguous-operate' || scenario === 'verify-decoy-operate') {
        expect(task?.lastError).toContain('Ambiguous read-only program authorization');
        expect(task?.lastError).toContain(`decoy-${scenario}/S1`);
        expect(task?.lastError).toContain(`${approved.id}/S1`);
        expect(task?.qwenSessionId).toBeNull();
        expect(store.listScorecards()).toHaveLength(0);
      }
      if (scenario === 'completion-decoy-operate') {
        expect(task?.lastError).toContain('Waiting for controller-owned staging verification of this exact commit');
        expect(store.listEvents('task.read_only_verified')).toHaveLength(0);
        expect(store.listScorecards()[0]?.passed).toBe(true);
      }
      store.close();
    }, 30_000,
  );

  it('does not auto-promote a self-repair label from an untrusted issue author', async () => {
    const root = makeTmp('untrusted-self-repair-root');
    const state = makeTmp('untrusted-self-repair-state');
    const config = defaultProjectConfig(root, 'fixture', 'owner/fixture');
    const store = new PersistentTaskStore('untrusted-self-repair-project', state);
    const github = new MockGitHub();
    (github.issues.get(1) as RemoteIssue).labels = ['self-repair'];
    const supervisor = new HarnessSupervisor(
      config,
      store,
      github,
      new GitWorkspace(root, state, config),
      new MockQwenExecutor(),
      new MockNormalizer(),
      new GateRunner(),
      new UniversalRewardEngine([
        new ExecutionEvaluator(),
        new PassingEvaluator('rubric'),
        new PassingEvaluator('agentic'),
      ]),
      silentLogger,
      'worker-untrusted-repair',
    );

    expect(await supervisor.syncIntake()).toBe(0);
    expect(store.list()).toHaveLength(0);
    store.close();
  });

  it('releases an interrupted Qwen attempt without consuming its retry budget', async () => {
    const { repo } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    config.intake.trustedAuthors.push('bot');
    const state = makeTmp('interrupted-state');
    const store = new PersistentTaskStore('interrupted-project', state);
    const github = new MockGitHub();
    const supervisor = new HarnessSupervisor(
      config,
      store,
      github,
      new GitWorkspace(repo, state, config),
      new BlockingQwenExecutor(),
      new MockNormalizer(),
      new GateRunner(),
      new UniversalRewardEngine([
        new ExecutionEvaluator(),
        new PassingEvaluator('rubric'),
        new PassingEvaluator('agentic'),
      ]),
      silentLogger,
      'worker-interrupted',
    );
    const controller = new AbortController();
    const tick = supervisor.tick(controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await tick;

    const task = store.findByIssue(2);
    expect(task).toMatchObject({
      state: 'ready',
      attempts: 0,
      qwenSessionId: 'qwen-session-interrupted',
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(task?.lastError).toContain('Worker shutdown interrupted');
    store.close();
  }, 30_000);

  it('waits and resumes provider-limited work without recording a code failure', async () => {
    const { repo } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    config.intake.trustedAuthors.push('bot');
    const state = makeTmp('provider-wait-state');
    const store = new PersistentTaskStore('provider-wait-project', state);
    const executor = new ProviderWaitingQwenExecutor();
    const execute = vi.spyOn(executor, 'execute');
    const supervisor = new HarnessSupervisor(
      config, store, new MockGitHub(), new GitWorkspace(repo, state, config),
      executor, new MockNormalizer(), new GateRunner(),
      new UniversalRewardEngine([new ExecutionEvaluator(), new PassingEvaluator('rubric'), new PassingEvaluator('agentic')]),
      silentLogger, 'worker-provider-wait',
    );

    await supervisor.tick();
    let task = store.findByIssue(2);
    expect(task).toMatchObject({ state: 'waiting', waitKind: 'provider', attempts: 0, continuations: 1,
      qwenAutomaticStop: null, qwenSessionId: 'qwen-session-provider-wait', lastError: null });
    store.patch(task?.id as string, { resumeAfter: Date.now() - 1 });
    await supervisor.tick();
    task = store.findByIssue(2);
    expect(task).toMatchObject({ state: 'waiting', waitKind: 'provider', attempts: 0, continuations: 2,
      qwenSessionId: 'qwen-session-provider-wait' });
    expect(store.listEvents('task.provider_resumed')).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]![0].feedback).toEqual([]);
    expect(execute.mock.calls[1]![0].feedback).toEqual([]);
    const waitEvents = store.listEvents('task.provider_wait');
    expect(waitEvents.map((event) => event.payload.reason)).toEqual(['provider temporarily overloaded', 'provider temporarily overloaded']);
    store.close();
  });

  it('converts repeated budget-only continuations into a bounded repair attempt', async () => {
    const { repo } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    config.intake.trustedAuthors.push('bot');
    config.worker.maxContinuations = 1;
    const state = makeTmp('budget-continuation-state');
    const store = new PersistentTaskStore('budget-continuation-project', state);
    const supervisor = new HarnessSupervisor(
      config, store, new MockGitHub(), new GitWorkspace(repo, state, config),
      new BudgetPausedQwenExecutor(), new MockNormalizer(), new GateRunner(),
      new UniversalRewardEngine([new ExecutionEvaluator(), new PassingEvaluator('rubric'), new PassingEvaluator('agentic')]),
      silentLogger, 'worker-budget-continuation',
    );

    await supervisor.tick();
    expect(store.findByIssue(2)).toMatchObject({ state: 'ready', attempts: 1, continuations: 1 });
    store.close();
  });

  it('persists observed automatic stops and clears them when the next session starts', async () => {
    const { repo } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    config.intake.trustedAuthors.push('bot');
    const state = makeTmp('automatic-stop-state');
    const store = new PersistentTaskStore('automatic-stop-project', state);
    const executor = new BudgetPausedQwenExecutor();
    const execute = vi.spyOn(executor, 'execute');
    const supervisor = new HarnessSupervisor(
      config, store, new MockGitHub(), new GitWorkspace(repo, state, config), executor, new MockNormalizer(), new GateRunner(),
      new UniversalRewardEngine([new ExecutionEvaluator(), new PassingEvaluator('rubric'), new PassingEvaluator('agentic')]),
      silentLogger, 'worker-automatic-stop',
    );
    await supervisor.tick();
    const task = store.findByIssue(2)!;
    expect(task).toMatchObject({ state: 'ready', attempts: 0, continuations: 1,
      qwenAutomaticStop: { sessionId: 'qwen-session-budget', workflowRunId: null, kind: 'turn-limit' } });
    execute.mockImplementationOnce(async input => {
      expect(input.task.qwenAutomaticStop).toEqual(task.qwenAutomaticStop);
      input.onSession?.('next-session');
      expect(store.get(task.id).qwenAutomaticStop).toBeNull();
      return { sessionId: 'next-session', workflowRunId: null, summary: 'provider waiting', goalState: 'usage_limited',
        goalReason: 'provider temporarily overloaded', needsContinuation: true, continuationKind: 'provider', usage: {}, durationMs: 1 };
    });
    await supervisor.tick();
    expect(store.get(task.id)).toMatchObject({ state: 'waiting', attempts: 0, continuations: 2,
      qwenSessionId: 'next-session', qwenAutomaticStop: null });
    store.close();
  });

  it('propagates worker shutdown through verification gates', async () => {
    const { repo } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    config.intake.trustedAuthors.push('bot');
    const state = makeTmp('interrupted-gate-state');
    const store = new PersistentTaskStore('interrupted-gate-project', state);
    const github = new MockGitHub();
    const gates = new BlockingGateRunner();
    const supervisor = new HarnessSupervisor(
      config,
      store,
      github,
      new GitWorkspace(repo, state, config),
      new MockQwenExecutor(),
      new MockNormalizer(),
      gates,
      new UniversalRewardEngine([
        new ExecutionEvaluator(),
        new PassingEvaluator('rubric'),
        new PassingEvaluator('agentic'),
      ]),
      silentLogger,
      'worker-interrupted-gate',
    );
    const controller = new AbortController();
    const tick = supervisor.tick(controller.signal);
    await gates.started;
    const beforeTask = store.findByIssue(2);
    expect(beforeTask).toBeDefined();
    const taskId = beforeTask!.id;
    const readyEvents = store.listEvents('task.candidate_ready').filter((event) => event.taskId === taskId);
    expect(readyEvents).toHaveLength(1);
    const candidate = readyEvents[0]!;
    expect(candidate.payload).toEqual(expect.objectContaining({
      commitSha: beforeTask!.commitSha,
      baseSha: beforeTask!.baseSha,
      branch: beforeTask!.branch,
      attempts: 0,
      readOnly: false,
    }));
    const decoy = store.recordEvent('task.candidate_ready', taskId, candidate.payload, 'decoy-candidate-marker');
    expect(decoy.id).not.toBe(candidate.id);
    controller.abort();
    await tick;

    const interrupted = store.listEvents('task.interrupted').find((event) => event.taskId === taskId);
    expect(interrupted).toBeDefined();
    expect(interrupted!.payload.candidateReadyEventId).toBe(candidate.id);
    expect(interrupted!.payload.candidateReadyEventId).not.toBe(decoy.id);

    const task = store.findByIssue(2);
    expect(task).toMatchObject({ state: 'ready', attempts: 0, leaseOwner: null, leaseExpiresAt: null });
    expect(task?.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(task?.lastError).toContain('Worker shutdown interrupted');
    store.close();
  }, 30_000);

  it.each(['pass', 'fail', 'recovery-abort'] as const)('recovers an interrupted exact candidate by rerunning verification without Qwen: %s', async (outcome) => {
    const { repo } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    config.intake.trustedAuthors.push('bot');
    config.worker.autoMerge = true;
    config.gates = [{ id: 'unit', kind: 'unit', command: process.execPath, args: ['check.mjs'], required: true, timeoutMs: 10_000 }];
    const state = makeTmp('candidate-recovery-state');
    const store = new PersistentTaskStore('candidate-recovery-project', state);
    try {
      const github = new MockGitHub();
      const git = new GitWorkspace(repo, state, config);
      const qwen = new MockQwenExecutor();
      const execute = vi.spyOn(qwen, 'execute');
      const reviewer = new PassingEvaluator('agentic');
      const evaluate = vi.spyOn(reviewer, 'evaluate');
      const rewards = new UniversalRewardEngine([new ExecutionEvaluator(), new PassingEvaluator('rubric'), reviewer]);
      const gates = new BlockingGateRunner();
      const controller = new AbortController();
      const firstTick = new HarnessSupervisor(config, store, github, git, qwen, new MockNormalizer(), gates, rewards, silentLogger, 'worker-recovery-abort').tick(controller.signal);
      await gates.started;
      controller.abort();
      await firstTick;
      const afterAbort = store.findByIssue(2)!;
      expect(afterAbort).toMatchObject({ state: 'ready', attempts: 0 });
      const marker = store.listEvents('task.candidate_ready').at(-1)!;
      const originalSha = afterAbort.commitSha as string;
      const originalSession = afterAbort.qwenSessionId as string;
      if (outcome === 'recovery-abort') {
        const original = github.listOpenIssues.bind(github);
        const middleAbort = new AbortController();
        const spy = vi.spyOn(github, 'listOpenIssues').mockImplementation(async (...args: Parameters<typeof original>) => {
          const issues = await original(...args);
          if (store.get(afterAbort.id).state === 'active') middleAbort.abort();
          return issues;
        });
        try {
          const middle = new HarnessSupervisor(config, store, github, git, qwen, new MockNormalizer(), new GateRunner(), rewards, silentLogger, 'worker-recovery-middle');
          await middle.tick(middleAbort.signal);
        } finally {
          spy.mockRestore();
        }
        const interrupted = store.listEvents('task.interrupted').filter((event) => event.taskId === afterAbort.id).at(-1);
        expect(interrupted?.payload).toMatchObject({
          from: 'active', candidateReadyEventId: marker.id, inheritedCandidateRecovery: true,
        });
        expect(store.listEvents('task.candidate_recovery_consumed')).toHaveLength(0);
      }
      const realGates = new GateRunner();
      const runAll = vi.spyOn(realGates, 'runAll');
      if (outcome === 'fail') {
        runAll.mockResolvedValueOnce([{
          id: 'unit', kind: 'unit', required: true, applicable: true, ok: false, exitCode: 1,
          stdout: '', stderr: 'forced failure', durationMs: 1, command: [], evidenceHash: 'failure',
        }]);
      }
      const supervisor = new HarnessSupervisor(config, store, github, git, qwen, new MockNormalizer(), realGates, rewards, silentLogger, 'worker-recovery-verify');
      await supervisor.tick();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(runAll).toHaveBeenCalled();
      const consumptions = store.listEvents('task.candidate_recovery_consumed');
      expect(consumptions).toHaveLength(1);
      expect(consumptions[0]!.payload).toEqual({ markerId: marker.id, eligible: true, consumerId: expect.any(String) });
      expect(store.findByIssue(2)).toMatchObject({ commitSha: originalSha, qwenSessionId: originalSession });
      if (outcome !== 'fail') {
        expect(store.findByIssue(2)).toMatchObject({ state: 'done' });
        expect(github.prs.size).toBe(1);
        expect(evaluate).toHaveBeenCalled();
      } else {
        expect(store.findByIssue(2)).toMatchObject({ state: 'ready', attempts: 1 });
        expect(github.prs.size).toBe(0);
        expect(evaluate).not.toHaveBeenCalled();
        await supervisor.tick();
        expect(execute).toHaveBeenCalledTimes(2);
        expect(store.findByIssue(2)).toMatchObject({ state: 'done' });
        expect(github.prs.size).toBe(1);
        expect(store.listEvents('task.candidate_recovery_consumed')).toHaveLength(1);
        expect(store.listEvents('task.candidate_recovery_consumed')[0]!.payload).toEqual(expect.objectContaining({ markerId: marker.id }));
      }
    } finally {
      store.close();
    }
  }, 30_000);

  it.each(['dirty', 'untrusted', 'lost-lease', 'dirty-abort', 'untrusted-abort'] as const)('guards interrupted candidate recovery against invalid evidence: %s', async (scenario) => {
    const { repo } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    config.intake.trustedAuthors.push('bot');
    config.worker.autoMerge = true;
    config.gates = [{ id: 'unit', kind: 'unit', command: process.execPath, args: ['check.mjs'], required: true, timeoutMs: 10_000 }];
    const state = makeTmp('candidate-guard-state');
    const store = new PersistentTaskStore(`candidate-guard-${scenario}`, state);
    let releaseUnhandledCapture: (() => void) | null = null;
    try {
      const github = new MockGitHub();
      const git = new GitWorkspace(repo, state, config);
      const qwen = new MockQwenExecutor();
      const execute = vi.spyOn(qwen, 'execute');
      const rewards = new UniversalRewardEngine([new ExecutionEvaluator(), new PassingEvaluator('rubric'), new PassingEvaluator('agentic')]);
      const gates = new BlockingGateRunner();
      const controller = new AbortController();
      const firstTick = new HarnessSupervisor(config, store, github, git, qwen, new MockNormalizer(), gates, rewards, silentLogger, 'worker-guard-abort').tick(controller.signal);
      await gates.started;
      controller.abort();
      await firstTick;
      const afterAbort = store.findByIssue(2)!;
      expect(afterAbort).toMatchObject({ state: 'ready', attempts: 0 });
      const marker = store.listEvents('task.candidate_ready').at(-1)!;
      const abortMidRecovery = scenario === 'dirty-abort' || scenario === 'untrusted-abort';
      if (scenario === 'dirty' || scenario === 'dirty-abort') writeFileSync(path.join(afterAbort.worktreePath!, 'extra.txt'), 'changed\n');
      if (scenario === 'untrusted' || scenario === 'untrusted-abort') (github.issues.get(2) as RemoteIssue).author = 'outsider';
      const unhandled: unknown[] = [];
      let foreignLeaseExpiresAt: number | null = null;
      if (scenario === 'lost-lease') {
        config.worker.leaseMs = 3_000;
        const capture = (error: unknown): void => { unhandled.push(error); };
        process.on('uncaughtException', capture);
        process.on('unhandledRejection', capture);
        releaseUnhandledCapture = () => {
          process.off('uncaughtException', capture);
          process.off('unhandledRejection', capture);
        };
        const realBaseSha = git.baseSha.bind(git);
        vi.spyOn(git, 'baseSha').mockImplementation(async () => {
          if (store.get(afterAbort.id).state === 'active') {
            store.patch(afterAbort.id, { leaseOwner: 'other-worker', leaseExpiresAt: Date.now() + 60_000 });
            foreignLeaseExpiresAt = store.get(afterAbort.id).leaseExpiresAt;
            await new Promise((resolve) => setTimeout(resolve, 1_200));
          }
          return realBaseSha();
        });
      }
      const realGates = new GateRunner();
      const runAll = vi.spyOn(realGates, 'runAll');
      const recoveryAbort = new AbortController();
      const originalListIssues = github.listOpenIssues.bind(github);
      const listIssuesSpy = abortMidRecovery
        ? vi.spyOn(github, 'listOpenIssues').mockImplementation(async (...args: Parameters<typeof originalListIssues>) => {
            const issues = await originalListIssues(...args);
            if (store.get(afterAbort.id).state === 'active') recoveryAbort.abort();
            return issues;
          })
        : null;
      const supervisor = new HarnessSupervisor(config, store, github, git, qwen, new MockNormalizer(), realGates, rewards, silentLogger, 'worker-guard-verify');
      await supervisor.tick(recoveryAbort.signal);
      listIssuesSpy?.mockRestore();
      const consumptions = store.listEvents('task.candidate_recovery_consumed');
      if (abortMidRecovery) {
        expect(execute).toHaveBeenCalledTimes(1);
        expect(runAll).not.toHaveBeenCalled();
        expect(github.prs.size).toBe(0);
        expect(consumptions).toHaveLength(0);
        expect(store.findByIssue(2)).toMatchObject({ state: 'ready', attempts: 0 });
        const stop = store.listEvents('task.interrupted').filter((event) => event.taskId === afterAbort.id).at(-1)!;
        expect(stop.payload).not.toHaveProperty('candidateReadyEventId');
        expect(stop.payload).not.toHaveProperty('inheritedCandidateRecovery');
      } else if (scenario === 'dirty') {
        expect(execute).toHaveBeenCalledTimes(2);
        expect(runAll).toHaveBeenCalled();
        expect(consumptions).toHaveLength(1);
        expect(consumptions[0]!.payload).toEqual({ markerId: marker.id, eligible: false, consumerId: expect.any(String) });
        expect(store.findByIssue(2)).toMatchObject({ state: 'done' });
        expect(github.prs.size).toBe(1);
      } else if (scenario === 'untrusted') {
        expect(execute).toHaveBeenCalledTimes(1);
        expect(runAll).not.toHaveBeenCalled();
        expect(github.prs.size).toBe(0);
        expect(consumptions).toHaveLength(0);
        expect(store.findByIssue(2)).toMatchObject({ state: 'ready', attempts: 1 });
        expect(store.findByIssue(2)!.lastError).toContain('reauthorization');
      } else {
        expect(execute).toHaveBeenCalledTimes(1);
        expect(runAll).not.toHaveBeenCalled();
        expect(github.prs.size).toBe(0);
        expect(consumptions).toHaveLength(0);
        expect(store.findByIssue(2)).toMatchObject({ state: 'active', leaseOwner: 'other-worker', attempts: 0 });
        expect(unhandled).toEqual([]);
        expect(store.findByIssue(2)?.leaseExpiresAt).toBe(foreignLeaseExpiresAt);
      }
    } finally {
      releaseUnhandledCapture?.();
      store.close();
    }
  }, 30_000);

  it('finishes read-only verification after two orderly interruptions without rerunning the model', async () => {
    const { repo } = await createGitFixture();
    writeFileSync(path.join(repo, 'feature.txt'), 'existing implementation\n');
    const git = async (args: string[]) => {
      const result = await runProcess({ command: 'git', args, cwd: repo, timeoutMs: 20_000 });
      expect(result.exitCode, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    await git(['add', 'feature.txt']);
    await git(['commit', '-m', 'existing feature']);
    await git(['push', 'origin', 'main']);
    const baseSha = await git(['rev-parse', 'HEAD']);
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    config.program.enabled = true;
    config.intake.trustedAuthors.push('bot');
    config.gates = [{ id: 'unit', kind: 'unit', command: process.execPath, args: ['check.mjs'], required: true, timeoutMs: 10_000 }];
    config.evolution.enabled = false;
    const state = makeTmp('twice-interrupted-verify-state');
    const store = new PersistentTaskStore('twice-interrupted-verify', state);
    try {
      const github = new MockGitHub();
      github.issues.clear();
      const coordinator = new PortfolioCoordinator(config, store, github);
      const created = await coordinator.createDraft({ sourcePath: 'OBJECTIVE.md', content: 'Verify the existing feature.', draft: {
        title: 'Existing feature', objective: 'Verify existing behavior', constraints: [], definitionOfDone: ['Independent verification passes'],
        technologyDecisions: [], deploymentDecisions: [], stories: [{
          key: 'S1', title: 'Verify existing feature', goal: 'Verify feature.txt and check.mjs', acceptanceCriteria: ['check.mjs passes'],
          constraints: [], requiredGateIds: ['unit'], rewardCriterionIds: ['execution', 'acceptance', 'independent-review'], risk: 'low',
          workType: 'verify', dependsOn: [], rollback: 'No repository change', technologyDecisionIds: [], deploymentDecisionIds: [],
        }],
      } });
      const approved = await coordinator.approve(created.plan.id);
      const issueNumber = approved.stories[0]!.normalizedIssueNumber as number;
      const workspace = new GitWorkspace(repo, state, config);
      const qwen = new ReadOnlyQwenExecutor();
      const execute = vi.spyOn(qwen, 'execute');
      const reviewer = new PassingEvaluator('agentic');
      const evaluate = vi.spyOn(reviewer, 'evaluate');
      const rewards = new UniversalRewardEngine([new ExecutionEvaluator(), new PassingEvaluator('rubric'), reviewer]);
      const markerIds: string[] = [];
      for (const round of [1, 2]) {
        const gates = new BlockingGateRunner();
        const controller = new AbortController();
        const tick = new HarnessSupervisor(config, store, github, workspace, qwen, new MockNormalizer(), gates, rewards, silentLogger, `worker-verify-interrupted-${round}`).tick(controller.signal);
        await gates.started;
        controller.abort();
        await tick;
        const interrupted = store.findByIssue(issueNumber)!;
        expect(interrupted).toMatchObject({ state: 'ready', attempts: 0, commitSha: baseSha });
        expect(execute).toHaveBeenCalledTimes(1);
        markerIds.push(store.listEvents('task.candidate_ready').at(-1)!.id);
        if (round === 2) {
          expect(markerIds[1]).not.toBe(markerIds[0]);
          const stop = store.listEvents('task.interrupted').filter((event) => event.taskId === interrupted.id).at(-1)!;
          expect(stop.payload.candidateReadyEventId).toBe(markerIds[1]);
          const first = store.listEvents('task.candidate_recovery_consumed');
          expect(first).toHaveLength(1);
          expect(first[0]!.payload).toEqual({ markerId: markerIds[0], eligible: true, consumerId: expect.any(String) });
        }
      }
      const realGates = new GateRunner();
      const runAll = vi.spyOn(realGates, 'runAll');
      await new HarnessSupervisor(config, store, github, workspace, qwen, new MockNormalizer(), realGates, rewards, silentLogger, 'worker-verify-recovered').tick();
      const done = store.findByIssue(issueNumber)!;
      expect(done).toMatchObject({ state: 'done', attempts: 0, qwenSessionId: 'read-only-session', baseSha, commitSha: baseSha, mergeSha: baseSha });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(runAll).toHaveBeenCalled();
      expect(evaluate).toHaveBeenCalled();
      expect(github.prs.size).toBe(0);
      const consumptions = store.listEvents('task.candidate_recovery_consumed');
      expect(consumptions).toHaveLength(2);
      expect(consumptions[1]!.payload).toEqual({ markerId: markerIds[1], eligible: true, consumerId: expect.any(String) });
      expect(consumptions[0]!.id).not.toBe(consumptions[1]!.id);
      expect(consumptions[0]!.payload.consumerId).not.toBe(consumptions[1]!.payload.consumerId);
    } finally {
      store.close();
    }
  }, 30_000);

  it('normalizes, leases, executes Qwen, gates, rewards, pushes, opens, merges, and post-merge verifies', async () => {
    const { repo, remote } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    config.intake.trustedAuthors.push('bot');
    config.worker.autoMerge = true;
    config.gates = [{ id: 'unit', kind: 'unit', command: process.execPath, args: ['check.mjs'], required: true, timeoutMs: 10_000 }];
    const state = makeTmp('production-state');
    const store = new PersistentTaskStore('fixture-project', state);
    const github = new MockGitHub();
    const git = new GitWorkspace(repo, state, config);
    await git.assertReady();
    const reward = new UniversalRewardEngine([
      new ExecutionEvaluator(),
      new PassingEvaluator('rubric'),
      new PassingEvaluator('agentic'),
    ]);
    const trace: unknown[] = [];
    const logger = new Logger({ sink: (record) => trace.push(record) });
    const supervisor = new HarnessSupervisor(
      config,
      store,
      github,
      git,
      new MockQwenExecutor(),
      new MockNormalizer(),
      new GateRunner(),
      reward,
      logger,
      'worker-1',
    );

    const result = await supervisor.tick();
    expect(result.ingested).toBe(1);
    const normalized = store.findByIssue(2);
    expect(normalized?.state).toBe('done');
    expect(normalized?.qwenSessionId).toBe('qwen-session-1');
    expect(normalized?.prNumber).toBe(1);
    expect(normalized?.rewardRunId).toBeTruthy();
    expect(normalized?.spec?.source.kind).toBe('community');
    expect(github.checks).toContain('Fern Delivery Harness / reward');
    expect(github.prs.get(1)?.merged).toBe(true);
    expect(github.comments.some((comment) => comment.number === 1 && comment.body.includes('Normalized'))).toBe(true);

    const remoteFeature = await runProcess({
      command: 'git',
      args: ['--git-dir', remote, 'show', `${normalized?.commitSha}:feature.txt`],
      cwd: repo,
      timeoutMs: 10_000,
    });
    expect(remoteFeature.exitCode).toBe(0);
    expect(remoteFeature.stdout).toContain('implemented by Qwen');
    expect(trace.some((entry) => JSON.stringify(entry).includes('failed'))).toBe(false);
    const verifications = store.listEvents('postmerge.verification');
    expect(verifications).toHaveLength(1);
    const verification = verifications[0];
    expect(verification?.taskId).toBe(normalized?.id);
    const payload = (verification?.payload ?? {}) as Record<string, unknown>;
    expect(payload.mergeSha).toBe(normalized?.mergeSha);
    expect(payload.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(payload.finishedAt as number).toBeGreaterThanOrEqual(payload.startedAt as number);
    expect(payload.passed).toBe(true);
    expect(payload.sideEffectFailure).toBe(false);
    expect(payload.gates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'unit', kind: 'unit', required: true, applicable: true, ok: true, exitCode: 0, evidenceHash: expect.any(String),
      }),
    ]));
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('"stdout"');
    expect(serialized).not.toContain('"stderr"');
    expect(serialized).not.toContain('"command"');
    store.close();
  }, 30_000);

  it('rejects gate side effects outside explicitly configured visual artifacts', async () => {
    const { repo } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    config.intake.trustedAuthors.push('bot');
    config.gates = [
      {
        id: 'mutating-gate',
        kind: 'custom',
        command: process.execPath,
        args: ['-e', "require('node:fs').writeFileSync('gate-output.txt', 'unexpected')"],
        required: true,
        timeoutMs: 10_000,
      },
    ];
    const state = makeTmp('gate-side-effect-state');
    const store = new PersistentTaskStore('gate-side-effect-project', state);
    const github = new MockGitHub();
    const supervisor = new HarnessSupervisor(
      config,
      store,
      github,
      new GitWorkspace(repo, state, config),
      new MockQwenExecutor(),
      new MockNormalizer(),
      new GateRunner(),
      new UniversalRewardEngine([
        new ExecutionEvaluator(),
        new PassingEvaluator('rubric'),
        new PassingEvaluator('agentic'),
      ]),
      silentLogger,
      'worker-gate-side-effect',
    );

    await supervisor.tick();
    const task = store.findByIssue(2);
    expect(task?.state).toBe('ready');
    expect(task?.lastError).toContain('Gates modified the exact verification worktree');
    expect(github.prs.size).toBe(0);
    store.close();
  }, 30_000);

  it('never marks a task done when its actual merge commit fails post-merge verification', async () => {
    const { repo } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    config.intake.trustedAuthors.push('bot');
    config.worker.autoMerge = true;
    config.gates = [
      {
        id: 'unit',
        kind: 'unit',
        command: process.execPath,
        args: ['check.mjs'],
        required: true,
        timeoutMs: 10_000,
      },
    ];
    const state = makeTmp('postmerge-failure-state');
    const store = new PersistentTaskStore('postmerge-failure-project', state);
    const github = new MockGitHub();
    const git = new GitWorkspace(repo, state, config);
    await git.assertReady();
    const supervisor = new HarnessSupervisor(
      config,
      store,
      github,
      git,
      new MockQwenExecutor(),
      new MockNormalizer(),
      new PostMergeFailingGateRunner(),
      new UniversalRewardEngine([
        new ExecutionEvaluator(),
        new PassingEvaluator('rubric'),
        new PassingEvaluator('agentic'),
      ]),
      silentLogger,
      'worker-postmerge-failure',
    );

    await supervisor.tick();
    const origin = store.findByIssue(2);
    expect(origin?.state).toBe('failed');
    expect(origin?.lastError).toContain('postmerge-regression');
    expect([...github.issues.values()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          number: 3,
          title: expect.stringMatching(/^\[self-repair\] Post-merge regression at [0-9a-f]{12}$/),
          labels: ['self-repair', 'harness:accept'],
        }),
      ]),
    );
    const verifications = store.listEvents('postmerge.verification');
    expect(verifications).toHaveLength(1);
    const verification = verifications[0];
    expect(verification?.taskId).toBe(origin?.id);
    const payload = (verification?.payload ?? {}) as Record<string, unknown>;
    expect(payload.mergeSha).toBe(origin?.mergeSha);
    expect(payload.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(payload.finishedAt as number).toBeGreaterThanOrEqual(payload.startedAt as number);
    expect(payload.passed).toBe(false);
    expect(payload.sideEffectFailure).toBe(false);
    expect(payload.gates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'postmerge-regression', kind: 'custom', required: true, applicable: true, ok: false, exitCode: 1, evidenceHash: 'postmerge-regression',
      }),
    ]));
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('"stdout"');
    expect(serialized).not.toContain('"stderr"');
    expect(serialized).not.toContain('regression reproduced');
    store.close();
  }, 30_000);

  it('records no passing post-merge verification when worker shutdown lands after the side-effect scan', async () => {
    const { repo } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    config.intake.trustedAuthors.push('bot');
    config.worker.autoMerge = true;
    config.gates = [{ id: 'unit', kind: 'unit', command: process.execPath, args: ['check.mjs'], required: true, timeoutMs: 10_000 }];
    const state = makeTmp('postmerge-abort-state');
    const store = new PersistentTaskStore('postmerge-abort-project', state);
    const github = new MockGitHub();
    const controller = new AbortController();
    const git = new AbortAfterSideEffectGitWorkspace(repo, state, config, () => controller.abort());
    const cleanup = vi.spyOn(git, 'removeOwnedWorktree');
    const supervisor = new HarnessSupervisor(
      config, store, github, git, new MockQwenExecutor(), new MockNormalizer(), new GateRunner(),
      new UniversalRewardEngine([new ExecutionEvaluator(), new PassingEvaluator('rubric'), new PassingEvaluator('agentic')]),
      silentLogger, 'worker-postmerge-abort',
    );
    await supervisor.tick(controller.signal);
    expect(store.listEvents('postmerge.verification')).toHaveLength(0);
    const task = store.findByIssue(2);
    expect(task).toMatchObject({ state: 'post_merge', attempts: 0, leaseOwner: null });
    expect(task?.mergeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(github.prs.get(1)?.merged).toBe(true);
    expect(cleanup.mock.calls.some(([worktree]) => String(worktree).includes('postmerge-'))).toBe(true);
    store.close();
  }, 30_000);

  it('keeps a merged task retryable and cleaned up when only the post-merge verification journal write fails', async () => {
    const { repo } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    config.intake.trustedAuthors.push('bot');
    config.worker.autoMerge = true;
    config.gates = [{ id: 'unit', kind: 'unit', command: process.execPath, args: ['check.mjs'], required: true, timeoutMs: 10_000 }];
    const state = makeTmp('postmerge-journal-state');
    const store = new PostmergeJournalFaultStore('postmerge-journal-project', state);
    const github = new MockGitHub();
    const git = new GitWorkspace(repo, state, config);
    const qwen = new MockQwenExecutor();
    const execute = vi.spyOn(qwen, 'execute');
    const cleanup = vi.spyOn(git, 'removeOwnedWorktree');
    const supervisor = new HarnessSupervisor(
      config, store, github, git, qwen, new MockNormalizer(), new GateRunner(),
      new UniversalRewardEngine([new ExecutionEvaluator(), new PassingEvaluator('rubric'), new PassingEvaluator('agentic')]),
      silentLogger, 'worker-postmerge-journal',
    );
    await supervisor.tick();
    expect(store.listEvents('postmerge.verification')).toHaveLength(0);
    let task = store.findByIssue(2);
    expect(task).toMatchObject({ state: 'post_merge', attempts: 1, prNumber: 1, leaseOwner: null, leaseExpiresAt: null });
    expect(task?.lastError).toContain('event journal offline for post-merge verification');
    expect(github.prs.get(1)?.merged).toBe(true);
    expect([...github.issues.values()].some((issue) => issue.labels.includes('self-repair'))).toBe(false);
    expect(github.comments.some((comment) => comment.number === 1 && comment.body.includes('routed for repair'))).toBe(false);
    expect(cleanup.mock.calls.some(([worktree]) => String(worktree).includes('postmerge-'))).toBe(true);
    await supervisor.tick();
    task = store.findByIssue(2);
    expect(task).toMatchObject({ state: 'done', attempts: 1, prNumber: 1, lastError: null });
    expect(store.listEvents('postmerge.verification')).toHaveLength(1);
    expect(store.listEvents('postmerge.retry_scheduled')).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(github.prs.size).toBe(1);
    store.close();
  }, 30_000);
});
