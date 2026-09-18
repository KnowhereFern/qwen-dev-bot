import { describe, expect, it } from 'vitest';
import { defaultProjectConfig } from '../src/core/config.js';
import { PersistentTaskStore } from '../src/core/persistent-store.js';
import type { RepositoryAssessment } from '../src/core/types.js';
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
    technologyDecisions: [
      { id: 'WEB', category: 'hosting', technology: 'Vercel', source: 'approved', rationale: 'Host the web app' },
      { id: 'AUTH', category: 'authentication', technology: 'Clerk', source: 'approved', rationale: 'Authenticate users' },
    ],
    deploymentDecisions: [
      {
        id: 'WEB_PREVIEW', component: 'web', provider: 'Vercel', environment: 'preview',
        authority: 'build-test-only', rationale: 'Prepare preview configuration',
      },
    ],
    stories: [
      {
        key: 'S1', title: 'Foundation', goal: 'Build the foundation', acceptanceCriteria: ['Foundation test passes'],
        constraints: [], requiredGateIds: ['test'], rewardCriterionIds: ['execution'], risk: 'low', workType: 'implement', dependsOn: [], rollback: 'Revert foundation',
        technologyDecisionIds: ['AUTH'], deploymentDecisionIds: [],
      },
      {
        key: 'S2', title: 'Feature', goal: 'Build the feature', acceptanceCriteria: ['Feature test passes'],
        constraints: [], requiredGateIds: ['test'], rewardCriterionIds: ['execution'], risk: 'medium', workType: 'implement', dependsOn: ['S1'], rollback: 'Revert feature',
        technologyDecisionIds: ['WEB'], deploymentDecisionIds: ['WEB_PREVIEW'],
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

    await expect(coordinator.approve(first.plan.id, { revision: 2, contentHash: first.plan.contentHash })).rejects.toThrow('program changed since review');
    await expect(coordinator.approve(first.plan.id, { revision: 1, contentHash: 'stale-objective-hash' })).rejects.toThrow('program changed since review');
    expect(github.issues).toHaveLength(3);
    expect(store.getPortfolioPlan(first.plan.id)?.approvedAt).toBeNull();

    const duplicate = await coordinator.createDraft({ sourcePath: 'REQUIREMENTS.md', content: 'same requirements', draft: draft() });
    expect(duplicate.created).toBe(false);
    expect(duplicate.plan.id).toBe(first.plan.id);
    expect(github.issues).toHaveLength(3);

    const approved = await coordinator.approve(first.plan.id, { revision: 1, contentHash: first.plan.contentHash });
    expect(approved.status).toBe('active');
    expect(github.issues).toHaveLength(5);
    const firstSpec = parseNormalizedSpec((github.issues.get(4) as RemoteIssue).body);
    const secondSpec = parseNormalizedSpec((github.issues.get(5) as RemoteIssue).body);
    expect(firstSpec?.dependencies).toEqual([]);
    expect(secondSpec?.dependencies).toEqual([2]);
    expect(secondSpec?.constraints).toContain('Preserve existing behavior');
    expect(firstSpec?.technologyDecisions.map((decision) => decision.id)).toEqual(['AUTH']);
    expect(secondSpec?.technologyDecisions.map((decision) => decision.id)).toEqual(['WEB']);
    expect(secondSpec?.deploymentDecisions).toEqual([
      expect.objectContaining({ id: 'WEB_PREVIEW', authority: 'build-test-only' }),
    ]);
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

  it('replaces an unapproved draft while retaining superseded proposal history', async () => {
    const root = makeTmp('portfolio-redraft-root');
    const config = defaultProjectConfig(root, 'project', 'owner/project');
    config.program.enabled = true;
    const store = new PersistentTaskStore('portfolio-redraft', makeTmp('portfolio-redraft-state'));
    const github = new PortfolioGitHub();
    const coordinator = new PortfolioCoordinator(config, store, github);
    const initial = draft();
    initial.stories[0]!.coverageIds = ['REQ1'];
    initial.stories[1]!.coverageIds = ['REQ2'];
    const assessment: RepositoryAssessment = {
      id: 'assessment_initial', projectId: store.projectId, commitSha: 'a'.repeat(40), dirty: false,
      detectedStacks: ['node'], files: ['package.json'], analyses: [],
      coverage: [
        { id: 'REQ1', requirement: 'Foundation', status: 'missing', requiredAction: 'implement', rationale: 'Missing', evidence: [] },
        { id: 'REQ2', requirement: 'Feature', status: 'missing', requiredAction: 'implement', rationale: 'Missing', evidence: [] },
      ],
      createdAt: 1,
    };
    const created = await coordinator.createDraft({
      sourcePath: 'PROJECT.md', content: 'program objective', draft: initial, assessment,
    });
    const replacement = draft();
    replacement.stories[0]!.title = 'Implement foundation fully';
    replacement.stories[0]!.coverageIds = ['REQ1'];
    replacement.stories[1]!.coverageIds = ['REQ2'];

    const redrafted = await coordinator.replaceUnapprovedDraft({
      planId: created.plan.id,
      sourcePath: 'PROJECT.md',
      content: 'program objective',
      draft: replacement,
      assessment: { ...assessment, id: 'assessment_replacement', createdAt: 2 },
      summary: 'Replace narrow verification plan',
    });

    expect(redrafted.status).toBe('awaiting_initial_approval');
    expect(redrafted.revision).toBe(2);
    expect(redrafted.stories.filter((story) => story.revision === 1).every((story) => Boolean(story.supersededAt))).toBe(true);
    expect(redrafted.stories.filter((story) => story.revision === 2)).toHaveLength(2);
    expect(redrafted.stories.find((story) => story.revision === 2)?.key).toMatch(/^R2_/);
    expect(redrafted.stories.filter((story) => story.revision === 2).every((story) => story.sourceIssueNumber !== null)).toBe(true);
    expect(redrafted.stories.every((story) => story.normalizedIssueNumber === null)).toBe(true);
    expect(coordinator.status(redrafted).counts).toEqual({ 'awaiting-approval': 2 });
    expect(coordinator.status(redrafted).stories).toHaveLength(4);
    const changed = await coordinator.replaceUnapprovedDraft({
      planId: redrafted.id, sourcePath: 'PROJECT.md', content: 'Complete the full delivery journey',
      draft: replacement, assessment, summary: 'User revised the proposed objective', reviseObjective: true,
      expected: { revision: 2, contentHash: redrafted.contentHash },
    });
    expect(changed.revision).toBe(3);
    expect(changed.sourceContent).toBe('Complete the full delivery journey');
    expect(changed.contentHash).not.toBe(redrafted.contentHash);
    expect(changed.revisions?.[0]?.objectiveSourceContent).toBe('program objective');
    expect(changed.revisions?.[1]?.objectiveContentHash).toBe(redrafted.contentHash);
    expect(changed.revisions?.at(-1)?.material).toBe(true);
    expect(changed.approvedAt).toBeNull();
    expect(changed.status).toBe('awaiting_initial_approval');
    expect(changed.stories.every((story) => story.normalizedIssueNumber === null)).toBe(true);
    expect(store.getPortfolioPlan(changed.id)?.sourceContent).toBe(changed.sourceContent);
    store.close();
  });

  it('rejects implicit, stale, relocated or already-approved objective changes before planning', async () => {
    const config = defaultProjectConfig(makeTmp('objective-guards'), 'project', 'owner/project');
    config.program.enabled = true;
    const store = new PersistentTaskStore('objective-guards', makeTmp('objective-guards-state'));
    try {
      const coordinator = new PortfolioCoordinator(config, store, new PortfolioGitHub());
      const { plan } = await coordinator.createDraft({ sourcePath: 'OBJECTIVE.md', content: 'Original', draft: draft() });
      const input = { planId: plan.id, sourcePath: plan.sourcePath, content: 'Revised objective' };
      const expected = { revision: 1, contentHash: plan.contentHash };
      expect(() => coordinator.assertCanRedraft(input)).toThrow('preserve the originally proposed objective');
      expect(() => coordinator.assertCanRedraft({ ...input, reviseObjective: true })).toThrow('review guards');
      expect(() => coordinator.assertCanRedraft({ ...input, reviseObjective: true, expected: { ...expected, revision: 2 } })).toThrow('changed since review');
      expect(() => coordinator.assertCanRedraft({ ...input, reviseObjective: true, expected: { ...expected, contentHash: 'stale' } })).toThrow('changed since review');
      expect(() => coordinator.assertCanRedraft({ ...input, sourcePath: 'OTHER.md', reviseObjective: true, expected })).toThrow('requirements file');
      store.savePortfolioPlan({ ...plan, status: 'active', approvedAt: 1 });
      expect(() => coordinator.assertCanRedraft({ ...input, reviseObjective: true, expected })).toThrow('before initial approval');
      expect(store.list()).toHaveLength(0);
    } finally { store.close(); }
  });

  it('activates only the current dependency wave in repository-aware program mode', async () => {
    const root = makeTmp('portfolio-wave-root');
    const config = defaultProjectConfig(root, 'project', 'owner/project');
    config.program.enabled = true;
    config.intake.trustedAuthors.push('owner');
    config.gates = [{ id: 'test', kind: 'unit', command: 'npm', args: ['test'], required: true, timeoutMs: 1_000 }];
    const store = new PersistentTaskStore('portfolio-wave', makeTmp('portfolio-wave-state'));
    const github = new PortfolioGitHub();
    const coordinator = new PortfolioCoordinator(config, store, github);
    const programDraft = draft();
    programDraft.stories[0]!.coverageIds = ['REQ1'];
    programDraft.stories[1]!.coverageIds = ['REQ2'];
    const assessment: RepositoryAssessment = {
      id: 'assessment_1', projectId: store.projectId, commitSha: 'a'.repeat(40), dirty: false,
      detectedStacks: ['node'], files: ['package.json'], analyses: [],
      coverage: [
        { id: 'REQ1', requirement: 'Foundation', status: 'missing' as const, requiredAction: 'implement' as const, rationale: 'Missing', evidence: [] },
        { id: 'REQ2', requirement: 'Feature', status: 'missing' as const, requiredAction: 'implement' as const, rationale: 'Missing', evidence: [] },
      ],
      createdAt: 1,
    };
    const created = await coordinator.createDraft({ sourcePath: 'PROJECT.md', content: 'program objective', draft: programDraft, assessment });
    expect(created.plan.status).toBe('awaiting_initial_approval');
    expect(created.plan.sourceContent).toBe('program objective');
    expect(created.plan.stories.map((story) => story.wave)).toEqual([1, 2]);

    const approved = await coordinator.approve(created.plan.id);
    expect(approved.stories[0]?.normalizedIssueNumber).not.toBeNull();
    expect(approved.stories[1]?.normalizedIssueNumber).toBeNull();
    const firstSpec = parseNormalizedSpec((github.issues.get(4) as RemoteIssue).body);
    store.upsert({ issueNumber: 4, title: 'Foundation', state: 'done', spec: firstSpec });
    const [assessing] = await coordinator.refresh(created.plan.id);
    expect(assessing?.status).toBe('assessing');

    const waveTwo = await coordinator.updateProgramState(created.plan.id, 'assessing');
    store.savePortfolioPlan({ ...waveTwo, currentWave: 2 });
    const active = await coordinator.activateWave(created.plan.id, 2);
    expect(active.stories[1]?.normalizedIssueNumber).not.toBeNull();
    store.close();
  });

  it('starts quarantine repairs without depending on the quarantined wave and applies an approved material revision', async () => {
    const root = makeTmp('portfolio-revision-root');
    const config = defaultProjectConfig(root, 'project', 'owner/project');
    config.program.enabled = true;
    config.intake.trustedAuthors.push('owner');
    config.gates = [{ id: 'test', kind: 'unit', command: 'npm', args: ['test'], required: true, timeoutMs: 1_000 }];
    const store = new PersistentTaskStore('portfolio-revision', makeTmp('portfolio-revision-state'));
    const github = new PortfolioGitHub();
    const coordinator = new PortfolioCoordinator(config, store, github);
    const initial = draft();
    initial.stories[0]!.coverageIds = ['REQ1'];
    initial.stories[1]!.coverageIds = ['REQ2'];
    const assessment: RepositoryAssessment = {
      id: 'assessment_initial', projectId: store.projectId, commitSha: 'a'.repeat(40), dirty: false,
      detectedStacks: ['node'], files: ['package.json'], analyses: [],
      coverage: [
        { id: 'REQ1', requirement: 'Foundation', status: 'missing', requiredAction: 'implement', rationale: 'Missing', evidence: [] },
        { id: 'REQ2', requirement: 'Feature', status: 'missing', requiredAction: 'implement', rationale: 'Missing', evidence: [] },
      ],
      createdAt: 1,
    };
    const created = await coordinator.createDraft({ sourcePath: 'PROJECT.md', content: 'program objective', draft: initial, assessment });
    const approved = await coordinator.approve(created.plan.id);
    const failedIssue = approved.stories[0]?.normalizedIssueNumber as number;
    store.upsert({
      issueNumber: failedIssue,
      title: 'quarantined foundation',
      state: 'quarantined',
      spec: parseNormalizedSpec((github.issues.get(failedIssue) as RemoteIssue).body),
      identicalFailures: 3,
      lastFailureFingerprint: 'same-failure',
      lineageFailures: 3,
    });

    const revisedDraft = draft();
    revisedDraft.technologyDecisions[0] = {
      ...revisedDraft.technologyDecisions[0]!,
      technology: 'Existing approved hosting',
    };
    revisedDraft.stories[0]!.coverageIds = ['REQ1'];
    revisedDraft.stories[1]!.coverageIds = ['REQ2'];
    const nextAssessment = { ...assessment, id: 'assessment_next', commitSha: 'b'.repeat(40), createdAt: 2 };
    const revised = await coordinator.revise({
      planId: created.plan.id,
      draft: revisedDraft,
      assessment: nextAssessment,
      reason: 'quarantine',
      material: true,
      approvedMaterial: true,
      summary: 'Approved recovery revision',
    });

    const newRoot = revised.stories.find((story) => story.revision === 2 && story.dependsOn.length === 0);
    expect(revised.status).toBe('active');
    expect(revised.technologyDecisions[0]?.technology).toBe('Existing approved hosting');
    expect(newRoot?.normalizedIssueNumber).not.toBeNull();
    const normalized = parseNormalizedSpec((github.issues.get(newRoot?.normalizedIssueNumber as number) as RemoteIssue).body);
    expect(normalized?.dependencies).toEqual([]);
    expect((github.issues.get(newRoot?.normalizedIssueNumber as number) as RemoteIssue).body).toContain(`Origin task: #${failedIssue}`);

    const waveRevision = await coordinator.revise({
      planId: created.plan.id,
      draft: revisedDraft,
      assessment: { ...nextAssessment, id: 'assessment_wave', commitSha: 'c'.repeat(40), createdAt: 3 },
      reason: 'wave-complete',
      material: false,
      summary: 'Next evidence-based wave',
    });
    const priorWaveKey = revised.stories.find((story) => story.revision === 2 && story.wave === 2)?.key;
    const waveRoot = waveRevision.stories.find((story) => story.revision === 3 && story.wave === 3);
    expect(waveRoot?.dependsOn).toContain(priorWaveKey);
    expect(waveRoot?.normalizedIssueNumber).not.toBeNull();
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
