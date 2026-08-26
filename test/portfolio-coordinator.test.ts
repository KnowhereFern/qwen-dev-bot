import { describe, expect, it } from 'vitest';
import { defaultProjectConfig } from '../src/core/config.js';
import { PersistentTaskStore } from '../src/core/persistent-store.js';
import type { CheckSummary, GitHubControl, RemoteIssue, RemotePullRequest } from '../src/github/control-plane.js';
import { parseNormalizedSpec } from '../src/intake/normalizer.js';
import { matchesPortfolioTaskContract, PortfolioCoordinator } from '../src/portfolio/coordinator.js';
import type { PortfolioDraft } from '../src/portfolio/planner.js';
import { makeTmp } from './helpers.js';

class PortfolioGitHub implements GitHubControl {
  readonly repoSlug = 'owner/project';
  readonly issues = new Map<number, RemoteIssue>();
  private nextIssue = 1;

  constructor(private readonly login = 'owner') {}

  async currentUser(): Promise<string> { return this.login; }
  async listOpenIssues(): Promise<RemoteIssue[]> { return [...this.issues.values()]; }
  async getIssue(number: number): Promise<RemoteIssue> { return this.issues.get(number) as RemoteIssue; }
  async createIssue(input: { title: string; body: string; labels: string[] }): Promise<RemoteIssue> {
    const number = this.nextIssue++;
    const issue = {
      number,
      title: input.title,
      body: input.body,
      labels: [...input.labels],
      author: this.login,
      url: `https://github.test/owner/project/issues/${number}`,
    };
    this.issues.set(number, issue);
    return issue;
  }
  async updateIssue(number: number, input: { title?: string; body?: string }): Promise<RemoteIssue> {
    const issue = this.issues.get(number) as RemoteIssue;
    if (input.title !== undefined) issue.title = input.title;
    if (input.body !== undefined) issue.body = input.body;
    return issue;
  }
  async comment(): Promise<void> {}
  async addLabels(): Promise<void> {}
  async removeLabel(): Promise<void> {}
  async findPullRequestByHead(): Promise<RemotePullRequest | null> { return null; }
  async createPullRequest(): Promise<RemotePullRequest> { throw new Error('not used'); }
  async getPullRequest(): Promise<RemotePullRequest> { throw new Error('not used'); }
  async checksForRef(): Promise<CheckSummary> { return { complete: true, successful: true, pending: [], failed: [] }; }
  async publishCheck(): Promise<void> {}
  async mergePullRequest(): Promise<{ merged: boolean; sha: string | null; message: string }> {
    throw new Error('not used');
  }
}

function draft(): PortfolioDraft {
  return {
    title: 'Demo application',
    objective: 'Deliver the minimum useful demo',
    constraints: ['Preserve existing behavior'],
    definitionOfDone: ['Every story is merged and verified'],
    stories: [
      {
        key: 'S1', title: 'Foundation', goal: 'Build the foundation', acceptanceCriteria: ['Foundation test passes'],
        constraints: [], requiredGateIds: ['test'], rewardCriterionIds: ['execution'], risk: 'low', dependsOn: [], rollback: 'Revert foundation',
      },
      {
        key: 'S2', title: 'Feature', goal: 'Build the feature', acceptanceCriteria: ['Feature test passes'],
        constraints: [], requiredGateIds: ['test'], rewardCriterionIds: ['execution'], risk: 'medium', dependsOn: ['S1'], rollback: 'Revert feature',
      },
    ],
  };
}

describe('PortfolioCoordinator', () => {
  it('publishes idempotent review issues, then creates an exact dependency-aware normalized graph only after approval', async () => {
    const root = makeTmp('portfolio-root');
    const config = defaultProjectConfig(root, 'project', 'owner/project');
    config.intake.trustedAuthors.push('owner');
    config.gates = [{ id: 'test', kind: 'unit', command: 'npm', args: ['test'], required: true, timeoutMs: 1_000 }];
    const store = new PersistentTaskStore('portfolio-project', makeTmp('portfolio-state'));
    const github = new PortfolioGitHub();
    const coordinator = new PortfolioCoordinator(config, store, github);

    const first = await coordinator.createDraft({ sourcePath: 'REQUIREMENTS.md', content: 'same requirements', draft: draft() });
    expect(first.created).toBe(true);
    expect(first.plan.status).toBe('draft');
    expect(github.issues).toHaveLength(3);
    expect([...github.issues.values()][0]?.labels).toEqual(['harness:plan']);
    expect([...github.issues.values()].slice(1).every((issue) => issue.labels.includes('harness:planned'))).toBe(true);

    const duplicate = await coordinator.createDraft({ sourcePath: 'REQUIREMENTS.md', content: 'same requirements', draft: draft() });
    expect(duplicate.created).toBe(false);
    expect(duplicate.plan.id).toBe(first.plan.id);
    expect(github.issues).toHaveLength(3);

    const approved = await coordinator.approve(first.plan.id);
    expect(approved.status).toBe('active');
    expect(github.issues).toHaveLength(5);
    const firstSpec = parseNormalizedSpec((github.issues.get(4) as RemoteIssue).body);
    const secondSpec = parseNormalizedSpec((github.issues.get(5) as RemoteIssue).body);
    expect(firstSpec?.dependencies).toEqual([]);
    expect(secondSpec?.dependencies).toEqual([2]);
    expect(secondSpec?.constraints).toContain('Preserve existing behavior');
    expect((github.issues.get(5) as RemoteIssue).labels).toEqual(['harness:normalized', 'harness:ready']);
    expect(matchesPortfolioTaskContract(approved, approved.stories[1]!, secondSpec!)).toBe(true);
    expect(matchesPortfolioTaskContract(approved, approved.stories[1]!, { ...secondSpec!, goal: 'edited later' })).toBe(false);

    store.upsert({ issueNumber: 4, title: 'Foundation', state: 'done', spec: firstSpec });
    store.upsert({ issueNumber: 5, title: 'Feature', state: 'done', spec: secondSpec });
    const [completed] = await coordinator.refresh(first.plan.id);
    expect(completed?.status).toBe('done');
    expect((github.issues.get(1) as RemoteIssue).body).toContain('- [x] [S2 Feature]');
    store.close();
  });

  it('refuses approval when the authenticated GitHub actor is not trusted', async () => {
    const root = makeTmp('portfolio-untrusted-root');
    const config = defaultProjectConfig(root, 'project', 'owner/project');
    const store = new PersistentTaskStore('portfolio-untrusted', makeTmp('portfolio-untrusted-state'));
    const coordinator = new PortfolioCoordinator(config, store, new PortfolioGitHub('stranger'));
    const created = await coordinator.createDraft({ sourcePath: 'REQUIREMENTS.md', content: 'requirements', draft: draft() });

    await expect(coordinator.approve(created.plan.id)).rejects.toThrow(/not in intake.trustedAuthors/);
    expect(store.getPortfolioPlan(created.plan.id)?.status).toBe('draft');
    store.close();
  });
});
