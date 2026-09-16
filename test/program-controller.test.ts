import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { defaultProjectConfig } from '../src/core/config.js';
import { PersistentTaskStore } from '../src/core/persistent-store.js';
import { projectIdFor } from '../src/core/state-paths.js';
import type { PortfolioPlan } from '../src/core/types.js';
import { EvolutionSignalCollector } from '../src/evolution/signals.js';
import type { CheckSummary, GitHubControl, RemoteIssue, RemotePullRequest } from '../src/github/control-plane.js';
import { PortfolioPlanner, type PortfolioPlanningModel } from '../src/portfolio/planner.js';
import { ProgramController } from '../src/program/controller.js';
import { RepositoryAssessor } from '../src/program/repository-assessor.js';
import { createGitFixture } from './fixtures/git.js';
import { makeTmp } from './helpers.js';

describe('ProgramController', () => {
  it('marks a program delivered only after an exact-commit objective audit passes', async () => {
    const { repo } = await createGitFixture();
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    config.program.enabled = true;
    config.evolution.enabled = false;
    const store = new PersistentTaskStore(projectIdFor(config), makeTmp('program-controller-state'));
    const github = new EmptyGitHub();
    const model = new ImplementedAssessmentModel();
    const story = {
      key: 'S1', title: 'Objective', goal: 'Deliver', acceptanceCriteria: ['Verified'], constraints: [], requiredGateIds: [], rewardCriterionIds: [],
      risk: 'low' as const, dependsOn: [], rollback: 'Revert', technologyDecisionIds: [], deploymentDecisionIds: [], coverageIds: ['REQ1'],
      sourceIssueNumber: 1, sourceIssueUrl: 'https://github.test/issues/1', normalizedIssueNumber: 10,
      normalizedIssueUrl: 'https://github.test/issues/10', wave: 1, revision: 1, supersededAt: null,
    };
    const plan: PortfolioPlan = {
      id: 'plan_1', projectId: store.projectId, sourcePath: 'PROJECT.md', contentHash: 'frozen', sourceContent: 'Ship the verified objective.',
      title: 'Objective', objective: 'Ship it', constraints: [], definitionOfDone: ['Verified'], technologyDecisions: [], deploymentDecisions: [],
      status: 'assessing', epicIssueNumber: null, epicIssueUrl: null, stories: [story], createdAt: 1, updatedAt: 1, approvedAt: 1,
      repositorySha: sha, assessmentId: 'initial', revision: 1, currentWave: 1,
      coverage: [{ id: 'REQ1', requirement: 'Ship', status: 'unverified', rationale: 'Pending audit', evidence: [] }],
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
    store.close();
  });
});

class ImplementedAssessmentModel implements PortfolioPlanningModel {
  calls = 0;
  async completeJson<T>(): Promise<{ value: T }> {
    this.calls += 1;
    const evidence = [{ kind: 'file', locator: 'README.md', summary: 'Verified fixture' }];
    return this.calls <= 4
      ? { value: { summary: 'Verified', findings: [{ capability: 'Objective', status: 'implemented', rationale: 'Verified', evidence }], risks: [] } as T }
      : { value: { coverage: [{ id: 'REQ1', requirement: 'Ship', status: 'implemented', rationale: 'Verified', evidence }] } as T };
  }
}

class EmptyGitHub implements GitHubControl {
  readonly repoSlug = 'owner/fixture';
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
  async checksForRef(): Promise<CheckSummary> { return { complete: true, successful: true, pending: [], failed: [] }; }
  async publishCheck(): Promise<void> {}
  async mergePullRequest(): Promise<{ merged: boolean; sha: string | null; message: string }> { throw new Error('not used'); }
}
