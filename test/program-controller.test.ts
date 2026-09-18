import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { defaultProjectConfig } from '../src/core/config.js';
import { PersistentTaskStore } from '../src/core/persistent-store.js';
import { projectIdFor } from '../src/core/state-paths.js';
import type { PortfolioPlan, TaskSpec } from '../src/core/types.js';
import { StagingDeploymentController } from '../src/deployment/controller.js';
import { EvolutionSignalCollector } from '../src/evolution/signals.js';
import type { CheckSummary, GitHubControl, RemoteIssue, RemotePullRequest } from '../src/github/control-plane.js';
import { PortfolioPlanner, type PortfolioPlanningModel } from '../src/portfolio/planner.js';
import { ProgramController } from '../src/program/controller.js';
import { RepositoryAssessor } from '../src/program/repository-assessor.js';
import { createGitFixture } from './fixtures/git.js';
import { makeTmp } from './helpers.js';

describe('ProgramController', () => {
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
