import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { defaultProjectConfig } from '../src/core/config.js';
import { PersistentTaskStore } from '../src/core/persistent-store.js';
import { projectIdFor } from '../src/core/state-paths.js';
import type { PortfolioPlan, TaskSpec } from '../src/core/types.js';
import { StagingDeploymentController } from '../src/deployment/controller.js';
import { EvolutionSignalCollector } from '../src/evolution/signals.js';
import { Logger, type LogRecord } from '../src/logger.js';
import type { CheckSummary, GitHubControl, RemoteIssue, RemotePullRequest } from '../src/github/control-plane.js';
import { PortfolioPlanner, type PortfolioPlanningModel } from '../src/portfolio/planner.js';
import { PortfolioCoordinator, RecoveryLineageError } from '../src/portfolio/coordinator.js';
import { materialRevision, preserveDecisionIdentities, ProgramController } from '../src/program/controller.js';
import { AssessmentContractError, RepositoryAssessor } from '../src/program/repository-assessor.js';
import { createGitFixture } from './fixtures/git.js';
import { makeTmp } from './helpers.js';

describe('ProgramController', () => {
  it('records safe planning progress and refuses publication after cancellation', async () => {
    const logs: LogRecord[] = [];
    const fixture = recoveryFixture('quarantined', 3, undefined, new Logger({ sink: (record) => logs.push(record) }));
    const plan = fixture.store.getPortfolioPlan('recovery')!;
    const abort = new AbortController();
    const assess = vi.spyOn(RepositoryAssessor.prototype, 'assess').mockResolvedValue({
      id: 'progress-assessment', projectId: fixture.store.projectId, commitSha: 'a'.repeat(40), dirty: false,
      files: [], analyses: [], detectedStacks: [], createdAt: 1,
      coverage: [{ id: 'REQ1', requirement: 'Deliver', status: 'missing', requiredAction: 'implement', rationale: 'Missing', evidence: [] }],
    });
    const revise = vi.spyOn(PortfolioCoordinator.prototype, 'revise');
    const planning = vi.spyOn(PortfolioPlanner.prototype, 'plan').mockImplementation(async (...args) => {
      expect(args[5]?.signal).toBe(abort.signal);
      args[5]?.onProgress?.({ stage: 'draft-started', attempt: 1, maxAttempts: 3 });
      abort.abort(new Error('cancelled before publication'));
      return { title: 'Draft', objective: 'Deliver', constraints: [], definitionOfDone: ['Verified'], technologyDecisions: [], deploymentDecisions: [], stories: [] };
    });
    try {
      await expect(fixture.controller.reassess(plan, 'manual', abort.signal, false, 'a'.repeat(40)))
        .rejects.toThrow('cancelled before publication');
      expect(revise).not.toHaveBeenCalled();
      expect(fixture.store.getPortfolioPlan(plan.id)).toEqual(plan);
      expect(fixture.store.listEvents('program.planning_progress').map((event) => event.payload)).toEqual([
        { planId: plan.id, revision: 1, assessmentId: 'progress-assessment', stage: 'draft-started', attempt: 1, maxAttempts: 3 },
      ]);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ msg: 'program planning progress', planId: plan.id, stage: 'draft-started', attempt: 1 });
    } finally {
      assess.mockRestore(); revise.mockRestore(); planning.mockRestore(); fixture.store.close();
    }
  });

  it('never treats pending material decisions as approved reassessment inputs', async () => {
    const fixture = recoveryFixture('quarantined', 3);
    const plan = fixture.store.getPortfolioPlan('recovery')!;
    await expect(fixture.controller.reassess({ ...plan, status: 'awaiting_material_approval' }))
      .rejects.toThrow('proposed decisions are not approved');
    fixture.store.close();
  });
  it('retains approved exceptions across reorderings and maps renamed references to frozen identities', () => {
    const plan = { technologyDecisions: [
      { id: 'OLD1', category: 'language', technology: 'TypeScript', source: 'exception', rationale: 'Approved' },
      { id: 'OLD2', category: 'runtime', technology: 'Node', source: 'approved', rationale: 'Approved' },
    ], deploymentDecisions: [{ id: 'DEP', component: 'web', provider: 'Railway', environment: 'staging', authority: 'staging', rationale: 'Approved' }] } as unknown as PortfolioPlan;
    const draft = { technologyDecisions: [...plan.technologyDecisions].reverse().map((d, i) => ({ ...d, id: `NEW${i}`, rationale: 'Reworded' })),
      deploymentDecisions: plan.deploymentDecisions.map((d) => ({ ...d, id: 'NEWDEP' })),
      stories: [{ technologyDecisionIds: ['NEW1'], deploymentDecisionIds: ['NEWDEP'] }],
    } as Awaited<ReturnType<PortfolioPlanner['plan']>>;
    const original = structuredClone(plan);
    expect(materialRevision(plan, draft)).toBe(false);
    preserveDecisionIdentities(plan, draft);
    expect(draft.technologyDecisions).toEqual(plan.technologyDecisions);
    expect(draft.stories[0]?.technologyDecisionIds).toEqual(['OLD1']);
    expect(draft.stories[0]?.deploymentDecisionIds).toEqual(['DEP']);
    expect(plan).toEqual(original);
    for (const change of [
      (next: typeof draft) => { next.technologyDecisions[0]!.technology = 'Python'; },
      (next: typeof draft) => { next.technologyDecisions[0]!.source = 'approved'; },
      (next: typeof draft) => { next.deploymentDecisions[0]!.environment = 'production'; },
      (next: typeof draft) => { next.deploymentDecisions[0]!.provider = 'Other'; },
      (next: typeof draft) => { next.deploymentDecisions[0]!.authority = 'build-test-only'; },
      (next: typeof draft) => { next.technologyDecisions.pop(); },
    ]) {
      const next = structuredClone(draft); change(next);
      expect(materialRevision(plan, next)).toBe(true);
      expect(() => preserveDecisionIdentities(plan, next)).toThrow(/material/);
    }
  });
  it.each(['failed', 'quarantined'] as const)('does not generate replacement budgets for exhausted %s work', async (state) => {
    const fixture = recoveryFixture(state, 5);
    const reassess = vi.spyOn(fixture.controller, 'reassess');
    expect((await fixture.controller.tick()).action).toBe('recovery-blocked');
    expect((await fixture.controller.tick()).action).toBe('recovery-blocked');
    expect(reassess).not.toHaveBeenCalled();
    expect(fixture.store.listEvents('program.recovery_budget_exhausted')).toHaveLength(1);
    expect(fixture.store.getPortfolioPlan('recovery')?.revision).toBe(1);
    expect(fixture.store.findByIssue(10)).toMatchObject({ state, attempts: 5, lineageFailures: 5 });
    fixture.store.close();
  });

  it('records a rejected recovery once across controller restarts, retaining approved work', async () => {
    const fixture = recoveryFixture('quarantined', 3);
    const error = new RecoveryLineageError('Split conflicting repairs', ['R2'], [10, 11], 'candidate-assessment');
    const reassess = vi.spyOn(fixture.controller, 'reassess').mockRejectedValue(error);
    expect((await fixture.controller.tick()).action).toBe('recovery-blocked');
    expect(reassess).toHaveBeenCalledOnce();
    const prior = fixture.store.getPortfolioPlan('recovery');
    fixture.store.close();
    const reopened = recoveryFixture('quarantined', 3, fixture.directory);
    const next = vi.spyOn(reopened.controller, 'reassess');
    expect((await reopened.controller.tick()).action).toBe('idle');
    expect(next).not.toHaveBeenCalled();
    expect(reopened.store.getPortfolioPlan('recovery')).toEqual(prior);
    expect(reopened.store.listEvents('program.revision_rejected')).toHaveLength(1);
    expect(reopened.store.listEvents('program.revision_rejected')[0]?.payload).toMatchObject({ assessmentId: 'candidate-assessment', originIssueNumbers: [10, 11], storyKeys: ['R2'] });
    reopened.store.close();
  });

  it('does not mark transient reassessment failures as permanently processed', async () => {
    const fixture = recoveryFixture('quarantined', 3);
    const reassess = vi.spyOn(fixture.controller, 'reassess').mockRejectedValue(new Error('Provider unavailable'));
    await expect(fixture.controller.tick()).rejects.toThrow('Provider unavailable');
    await expect(fixture.controller.tick()).rejects.toThrow('Provider unavailable');
    expect(reassess).toHaveBeenCalledTimes(2);
    expect(fixture.store.listEvents('program.quarantine_processed')).toHaveLength(0);
    fixture.store.close();
  });

  it('does not repeatedly request synthesis after it changes frozen requirement identities', async () => {
    const fixture = recoveryFixture('quarantined', 3);
    const reassess = vi.spyOn(fixture.controller, 'reassess').mockRejectedValue(new AssessmentContractError('Missing REQ1'));
    expect((await fixture.controller.tick()).action).toBe('recovery-blocked');
    expect((await fixture.controller.tick()).action).toBe('idle');
    expect(reassess).toHaveBeenCalledOnce();
    expect(fixture.store.listEvents('program.revision_rejected')[0]?.payload).toMatchObject({ classification: 'assessment-contract' });
    fixture.store.close();
  });
  it.each(['ready', 'writer-active', 'pending-ci', 'missing-request', 'stale', 'altered-contract', 'unapproved'] as const)(
    'verifies staging without completing pending acceptance: %s', async (scenario) => {
      const { repo } = await createGitFixture();
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
      const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
      config.program.enabled = true; config.evolution.enabled = false; config.deployment.staging.enabled = true;
      const store = new PersistentTaskStore(projectIdFor(config), makeTmp('pending-operation-state'));
      const story = {
        key: 'S1', title: 'Audit staging', goal: 'Verify staging', acceptanceCriteria: ['Verified'], constraints: [], requiredGateIds: [], rewardCriterionIds: [],
        risk: 'low' as const, workType: 'operate' as const, dependsOn: [], rollback: 'No code change', technologyDecisionIds: [], deploymentDecisionIds: [],
        sourceIssueNumber: 1, sourceIssueUrl: 'https://github.test/issues/1', normalizedIssueNumber: 10, normalizedIssueUrl: 'https://github.test/issues/10', wave: 1,
      };
      const plan: PortfolioPlan = {
        id: 'pending_plan', projectId: store.projectId, sourcePath: 'OBJECTIVE.md', contentHash: 'frozen', sourceContent: 'Verify staging',
        title: 'Staging audit', objective: 'Verify staging', constraints: [], definitionOfDone: ['Verified'], technologyDecisions: [], deploymentDecisions: [],
        status: scenario === 'unapproved' ? 'awaiting_initial_approval' : 'active', epicIssueNumber: null, epicIssueUrl: null,
        stories: scenario === 'writer-active' ? [story, { ...story, key: 'S2', workType: 'implement', sourceIssueNumber: 2, normalizedIssueNumber: 11 }] : [story],
        createdAt: 1, updatedAt: 1, approvedAt: scenario === 'unapproved' ? null : 1, currentWave: 1,
      };
      store.savePortfolioPlan(plan);
      const spec: TaskSpec = {
        goal: scenario === 'altered-contract' ? 'Bypass checks' : story.goal, source: { kind: 'developer', url: story.sourceIssueUrl },
        acceptanceCriteria: story.acceptanceCriteria, constraints: [], requiredGateIds: [], rewardCriterionIds: [], risk: 'low',
        dependencies: [], rollback: story.rollback, technologyDecisions: [], deploymentDecisions: [],
      };
      const taskSha = scenario === 'stale' ? 'a'.repeat(40) : sha;
      const task = store.upsert({ issueNumber: 10, title: 'Audit staging', state: 'waiting', spec });
      store.patch(task.id, { waitKind: 'provider', baseSha: taskSha, commitSha: taskSha });
      store.saveScorecard({
        id: 'review', taskId: task.id, projectId: store.projectId, commitSha: taskSha, evaluatorVersion: 'fixture', hardGatePass: true,
        aggregateScore: 1, aggregateThreshold: 1, passed: true, criteria: [], evidence: [], blockingReasons: [], createdAt: 1,
      });
      if (scenario !== 'missing-request') store.recordEvent('task.staging_preparation_requested', task.id, { commitSha: taskSha });
      if (scenario === 'writer-active') store.upsert({ issueNumber: 11, title: 'Writer', state: 'active' });
      const github = new EmptyGitHub();
      if (scenario === 'pending-ci') github.checkSummary = { complete: false, successful: false, pending: ['CI'], failed: [] };
      let deployments = 0;
      class FakeDeployer extends StagingDeploymentController {
        override async deploy(input: { planId: string; wave: number; commitSha: string }) {
          deployments += 1;
          return store.saveDeployment({
            id: 'live-proof', projectId: store.projectId, planId: input.planId, wave: input.wave, provider: 'railway', commitSha: input.commitSha,
            previousVerifiedCommitSha: null, externalId: 'existing-service', status: 'succeeded', healthUrl: 'https://staging.test/health',
            observedRevision: input.commitSha, error: null, startedAt: 1, updatedAt: 2, completedAt: 2,
          });
        }
      }
      const model = new ImplementedAssessmentModel('unit');
      const controller = new ProgramController(config, store, github, new RepositoryAssessor(config, model), new PortfolioPlanner(config, model),
        new EvolutionSignalCollector(config, store, github, model), new FakeDeployer(config, store));
      const result = await controller.tick();
      expect(deployments).toBe(scenario === 'ready' ? 1 : 0);
      expect(result.action).toBe(scenario === 'ready' ? 'deployed' : 'idle');
      expect(store.get(task.id).state).toBe('waiting');
      expect(store.getPortfolioPlan(plan.id)?.deliveredAt).toBeUndefined();
      if (scenario === 'ready') { await controller.tick(); expect(deployments).toBe(1); }
      store.close();
    }, 30_000,
  );
  it('marks a program delivered only after an exact-commit objective audit passes', async () => {
    const { repo } = await createGitFixture();
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    config.program.enabled = true;
    config.evolution.enabled = false;
    config.gates = [{ id: 'syntax', kind: 'custom', command: 'node', args: ['--check', 'README.md'], required: true, timeoutMs: 1_000 }];
    const store = new PersistentTaskStore(projectIdFor(config), makeTmp('program-controller-state'));
    const github = new EmptyGitHub();
    const model = new ImplementedAssessmentModel(config.gates[0]?.id ?? 'syntax');
    const story = {
      key: 'S1', title: 'Objective', goal: 'Deliver', acceptanceCriteria: ['Verified'], constraints: [], requiredGateIds: [], rewardCriterionIds: [],
      risk: 'low' as const, workType: 'verify' as const, dependsOn: [], rollback: 'Revert', technologyDecisionIds: [], deploymentDecisionIds: [], coverageIds: ['REQ1'],
      sourceIssueNumber: 1, sourceIssueUrl: 'https://github.test/issues/1', normalizedIssueNumber: 10,
      normalizedIssueUrl: 'https://github.test/issues/10', wave: 1, revision: 1, supersededAt: null,
    };
    const plan: PortfolioPlan = {
      id: 'plan_1', projectId: store.projectId, sourcePath: 'PROJECT.md', contentHash: 'frozen', sourceContent: 'Ship the verified objective.',
      title: 'Objective', objective: 'Ship it', constraints: [], definitionOfDone: ['Verified'], technologyDecisions: [], deploymentDecisions: [],
      status: 'assessing', epicIssueNumber: null, epicIssueUrl: null, stories: [story], createdAt: 1, updatedAt: 1, approvedAt: 1,
      repositorySha: sha, assessmentId: 'initial', revision: 1, currentWave: 1,
      coverage: [{ id: 'REQ1', requirement: 'Ship', status: 'unverified', requiredAction: 'verify', rationale: 'Pending audit', evidence: [] }],
      revisions: [{ number: 1, assessmentId: 'initial', repositorySha: sha, reason: 'initial', material: false, summary: 'Initial', createdAt: 1, approvedAt: 1 }],
      latestDeploymentId: null, deliveredAt: null, maintenanceStartedAt: null,
    };
    store.savePortfolioPlan(plan);
    store.upsert({ issueNumber: 10, title: 'Objective', state: 'done' });
    const controller = new ProgramController(
      config, store, github, new RepositoryAssessor(config, model), new PortfolioPlanner(config, model),
      new EvolutionSignalCollector(config, store, github, model),
    );

    const result = await controller.tick();
    const updated = store.getPortfolioPlan(plan.id);
    expect(result.action).toBe('maintaining');
    expect(updated).toMatchObject({ status: 'maintaining', repositorySha: sha });
    expect(updated?.coverage?.[0]).toMatchObject({ id: 'REQ1', status: 'implemented' });
    expect(updated?.deliveredAt).toBeTypeOf('number');
    expect(github.checkedNames).toEqual(['Fern Delivery Harness / CI']);
    store.close();
  });
});

function recoveryFixture(state: 'failed' | 'quarantined', failures: number, directory = makeTmp('recovery-budget-controller'), logger?: Logger) {
  const config = defaultProjectConfig(directory, 'fixture', 'owner/fixture');
  config.program.enabled = true; config.evolution.enabled = false;
  const store = new PersistentTaskStore(projectIdFor(config), directory);
  if (!store.getPortfolioPlan('recovery')) {
    store.savePortfolioPlan({
      id: 'recovery', projectId: store.projectId, sourcePath: 'OBJECTIVE.md', contentHash: 'approved', sourceContent: 'Deliver',
      title: 'Recovery', objective: 'Deliver', constraints: [], definitionOfDone: ['Verified'], technologyDecisions: [], deploymentDecisions: [],
      status: 'blocked', epicIssueNumber: null, epicIssueUrl: null, createdAt: 1, updatedAt: 1, approvedAt: 1, revision: 1, currentWave: 1,
      stories: [{ key: 'S1', title: 'Repair', goal: 'Repair', acceptanceCriteria: ['Verified'], constraints: [], requiredGateIds: [], rewardCriterionIds: [],
        risk: 'low', workType: 'implement', dependsOn: [], rollback: 'Revert', technologyDecisionIds: [], deploymentDecisionIds: [], coverageIds: ['REQ1'],
        sourceIssueNumber: 1, sourceIssueUrl: 'https://github.test/issues/1', normalizedIssueNumber: 10, normalizedIssueUrl: 'https://github.test/issues/10', wave: 1 }],
    });
    const task = store.upsert({ issueNumber: 10, title: 'Repair', state, maxAttempts: 5, lineageFailures: failures, identicalFailures: 3 });
    store.patch(task.id, { attempts: failures });
  }
  const github = new EmptyGitHub();
  const model = new ImplementedAssessmentModel('unit');
  const controller = new ProgramController(config, store, github, new RepositoryAssessor(config, model), new PortfolioPlanner(config, model), new EvolutionSignalCollector(config, store, github, model), undefined, logger);
  return { controller, store, directory };
}

class ImplementedAssessmentModel implements PortfolioPlanningModel {
  calls = 0;
  constructor(private readonly gateId: string) {}
  async completeJson<T>(): Promise<{ value: T }> {
    this.calls += 1;
    const evidence = [{ kind: 'test', locator: this.gateId, summary: 'Exact-commit checks passed' }];
    return this.calls <= 4
      ? { value: { summary: 'Verified', findings: [{ capability: 'Objective', status: 'implemented', rationale: 'Verified', evidence }], risks: [] } as T }
      : { value: { coverage: [{ id: 'REQ1', requirement: 'Ship', status: 'implemented', requiredAction: 'none', rationale: 'Verified', evidence }] } as T };
  }
}

class EmptyGitHub implements GitHubControl {
  readonly repoSlug = 'owner/fixture';
  checkedNames: string[] = [];
  checkSummary: CheckSummary = { complete: true, successful: true, pending: [], failed: [] };
  async currentUser(): Promise<string> { return 'owner'; }
  async listOpenIssues(): Promise<RemoteIssue[]> { return []; }
  async getIssue(): Promise<RemoteIssue> { throw new Error('not used'); }
  async createIssue(): Promise<RemoteIssue> { throw new Error('not used'); }
  async updateIssue(): Promise<RemoteIssue> { throw new Error('not used'); }
  async comment(): Promise<void> {}
  async addLabels(): Promise<void> {}
  async removeLabel(): Promise<void> {}
  async findPullRequestByHead(): Promise<RemotePullRequest | null> { return null; }
  async createPullRequest(): Promise<RemotePullRequest> { throw new Error('not used'); }
  async getPullRequest(): Promise<RemotePullRequest> { throw new Error('not used'); }
  async checksForRef(_sha: string, requiredNames: string[]): Promise<CheckSummary> {
    this.checkedNames = requiredNames;
    return this.checkSummary;
  }
  async publishCheck(): Promise<void> {}
  async mergePullRequest(): Promise<{ merged: boolean; sha: string | null; message: string }> { throw new Error('not used'); }
}
