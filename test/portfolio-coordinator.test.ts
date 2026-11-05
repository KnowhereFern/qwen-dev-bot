import { describe, expect, it } from 'vitest';
import { defaultProjectConfig } from '../src/core/config.js';
import { PersistentTaskStore } from '../src/core/persistent-store.js';
import type { RepositoryAssessment } from '../src/core/types.js';
import type { CheckSummary, GitHubControl, RemoteIssue, RemotePullRequest } from '../src/github/control-plane.js';
import { parseNormalizedSpec } from '../src/intake/normalizer.js';
import { matchesPortfolioTaskContract, PortfolioCoordinator, RecoveryLineageError } from '../src/portfolio/coordinator.js';
import type { PortfolioDraft } from '../src/portfolio/planner.js';
import { makeTmp } from './helpers.js';

class PortfolioGitHub implements GitHubControl {
  readonly repoSlug = 'owner/project';
  readonly issues = new Map<number, RemoteIssue>();
  readonly updateCalls: number[] = [];
  readonly readCalls: number[] = [];
  private nextIssue = 1;

  constructor(private readonly login = 'owner') {}

  async currentUser(): Promise<string> { return this.login; }
  async listOpenIssues(): Promise<RemoteIssue[]> { this.readCalls.push(-1); return [...this.issues.values()]; }
  async getIssue(number: number): Promise<RemoteIssue> { this.readCalls.push(number); return this.issues.get(number) as RemoteIssue; }
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
    this.updateCalls.push(number);
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
  it('supersedes issued but unstarted repeat work after verified or external coverage', async () => {
    const config = defaultProjectConfig(makeTmp('retire-issued-root'), 'project', 'owner/project');
    config.program.enabled = true;
    config.intake.trustedAuthors.push('owner');
    config.gates = [{ id: 'test', kind: 'unit', command: 'npm', args: ['test'], required: true, timeoutMs: 1_000 }];
    const store = new PersistentTaskStore('retire-issued', makeTmp('retire-issued-state'));
    const coordinator = new PortfolioCoordinator(config, store, new PortfolioGitHub());
    const item = (id: string, status: 'partial' | 'implemented' | 'externally_blocked') => ({
      id, requirement: id, status, requiredAction: (status === 'implemented' ? 'none' : status === 'externally_blocked' ? 'external' : 'implement') as 'none' | 'external' | 'implement',
      rationale: status, evidence: [],
    });
    try {
      const initial: RepositoryAssessment = { id: 'before-retire', projectId: store.projectId, commitSha: 'a'.repeat(40), dirty: false,
        detectedStacks: ['node'], files: [], analyses: [], coverage: [item('A', 'partial'), item('B', 'partial')], createdAt: 1 };
      store.saveRepositoryAssessment(initial);
      const proposed = draft();
      proposed.stories = proposed.stories.map((story, index) => ({ ...story, coverageIds: [index === 0 ? 'A' : 'B'], dependsOn: [] }));
      const created = await coordinator.createDraft({ sourcePath: 'PROJECT.md', content: 'objective', draft: proposed, assessment: initial });
      const approved = await coordinator.approve(created.plan.id);
      const issued = approved.stories.map((story) => story.normalizedIssueNumber);
      expect(issued.every((number) => number !== null)).toBe(true);
      const next: RepositoryAssessment = { ...initial, id: 'after-retire', coverage: [item('A', 'implemented'), item('B', 'externally_blocked')] };
      store.saveRepositoryAssessment(next);
      const revised = await coordinator.revise({ planId: approved.id, draft: { ...proposed, stories: [] }, assessment: next,
        reason: 'manual', material: false, summary: 'Evidence resolved issued repeats' });
      expect(revised.stories.filter((story) => issued.includes(story.normalizedIssueNumber)).every((story) => story.supersededAt !== null)).toBe(true);
      expect(revised.stories.filter((story) => !story.supersededAt)).toHaveLength(0);
    } finally { store.close(); }
  });

  it('preserves issued work while a material revision awaits approval', async () => {
    const config = defaultProjectConfig(makeTmp('material-retire-root'), 'project', 'owner/project');
    config.program.enabled = true;
    config.intake.trustedAuthors.push('owner');
    config.gates = [{ id: 'test', kind: 'unit', command: 'npm', args: ['test'], required: true, timeoutMs: 1_000 }];
    const store = new PersistentTaskStore('material-retire', makeTmp('material-retire-state'));
    const coordinator = new PortfolioCoordinator(config, store, new PortfolioGitHub());
    try {
      const before: RepositoryAssessment = { id: 'before-material', projectId: store.projectId, commitSha: 'a'.repeat(40), dirty: false,
        detectedStacks: ['node'], files: [], analyses: [], coverage: [{ id: 'A', requirement: 'A', status: 'partial', requiredAction: 'implement', rationale: 'Open', evidence: [] }], createdAt: 1 };
      store.saveRepositoryAssessment(before);
      const proposed = draft();
      proposed.stories = [{ ...proposed.stories[0], coverageIds: ['A'] }];
      const created = await coordinator.createDraft({ sourcePath: 'PROJECT.md', content: 'objective', draft: proposed, assessment: before });
      const approved = await coordinator.approve(created.plan.id);
      const after: RepositoryAssessment = { ...before, id: 'after-material', coverage: [{ ...before.coverage[0], status: 'implemented', requiredAction: 'none' }] };
      store.saveRepositoryAssessment(after);
      const changed = { ...proposed, technologyDecisions: [{ ...proposed.technologyDecisions[0], technology: 'Different host' }] };
      const pending = await coordinator.revise({ planId: approved.id, draft: changed, assessment: after,
        reason: 'manual', material: true, summary: 'Pending approval' });
      expect(pending.status).toBe('awaiting_material_approval');
      expect(pending.stories[0].supersededAt).toBeNull();
    } finally { store.close(); }
  });

  it.each(['snapshot', 'legacy', 'missing-proof', 'normalized', 'stale', 'concurrent'] as const)('rejects material revisions without losing approved history: %s', async (scenario) => {
    const config = defaultProjectConfig(makeTmp('reject-root'), 'project', 'owner/project');
    config.program.enabled = true; config.intake.trustedAuthors.push('owner');
    config.gates = [{ id: 'test', kind: 'unit', command: 'npm', args: ['test'], required: true, timeoutMs: 1_000 }];
    const store = new PersistentTaskStore('reject-project', makeTmp('reject-state'));
    const github = new PortfolioGitHub();
    const coordinator = new PortfolioCoordinator(config, store, github);
    try {
      const assessment: RepositoryAssessment = { id: 'before', projectId: store.projectId, commitSha: 'a'.repeat(40), dirty: false, detectedStacks: ['node'], files: [], analyses: [], coverage: [], createdAt: 1 };
      store.saveRepositoryAssessment(assessment);
      const created = await coordinator.createDraft({ sourcePath: 'PROJECT.md', content: 'objective', draft: draft(), assessment });
      const approved = await coordinator.approve(created.plan.id);
      store.upsert({ issueNumber: approved.stories[0].normalizedIssueNumber!, title: 'done', state: 'done' });
      const changed = draft(); changed.technologyDecisions = [{ ...changed.technologyDecisions[0], technology: 'Different hosting' }];
      changed.constraints.push('New unapproved constraint'); changed.definitionOfDone.push('New unapproved criterion');
      const nextAssessment = { ...assessment, id: 'after', commitSha: 'b'.repeat(40) }; store.saveRepositoryAssessment(nextAssessment);
      let pending = await coordinator.revise({ planId: approved.id, draft: changed, assessment: nextAssessment, reason: 'wave-complete', material: true, summary: 'Unapproved scope change' });
      const savedContract = pending.revisions!.at(-1)!.priorApprovedContract!;
      expect(savedContract.technologyDecisions).toEqual(approved.technologyDecisions);
      if (scenario === 'legacy' || scenario === 'missing-proof') {
        pending = { ...pending, revisions: pending.revisions!.map((entry) => ({ ...entry, priorApprovedContract: undefined })) };
        store.savePortfolioPlan(pending);
      }
      if (scenario === 'normalized') {
        pending = { ...pending, stories: pending.stories.map((story) => story.revision === 2 ? { ...story, normalizedIssueNumber: 999 } : story) };
        store.savePortfolioPlan(pending);
      }
      const issuesBefore = github.issues.size;
      const request = { planId: pending.id, expected: { revision: scenario === 'stale' ? 1 : 2, contentHash: pending.contentHash }, operator: 'Test operator', reason: 'Preserve approved decisions',
        ...(scenario === 'legacy' ? { legacyRecovery: { contract: savedContract, provenance: 'Verified master issue history at approved revision' } } : {}) };
      if (scenario === 'concurrent') {
        let release!: () => void;
        let entered!: () => void;
        const waiting = new Promise<void>((resolve) => { entered = resolve; });
        const resume = new Promise<void>((resolve) => { release = resolve; });
        github.listOpenIssues = async () => { entered(); await resume; return [...github.issues.values()]; };
        const rejection = coordinator.rejectMaterialRevision(request);
        await waiting;
        const concurrentlyApproved = { ...pending, status: 'active' as const, updatedAt: pending.updatedAt + 1 };
        store.savePortfolioPlan(concurrentlyApproved);
        release();
        await expect(rejection).rejects.toThrow('changed during rejection');
        expect(store.getPortfolioPlan(pending.id)).toEqual(concurrentlyApproved);
      } else if (['missing-proof', 'normalized', 'stale'].includes(scenario)) {
        await expect(coordinator.rejectMaterialRevision(request)).rejects.toThrow();
        expect(store.getPortfolioPlan(pending.id)).toEqual(pending);
      } else {
        const restored = await coordinator.rejectMaterialRevision(request);
        expect(restored.revision).toBe(3); expect(restored.currentWave).toBe(1); expect(restored.status).toBe('assessing');
        expect(restored.technologyDecisions).toEqual(approved.technologyDecisions);
        expect(restored.constraints).toEqual(approved.constraints); expect(restored.definitionOfDone).toEqual(approved.definitionOfDone);
        expect(restored.stories[0]).toEqual(approved.stories[0]);
        expect(restored.stories[1].supersededAt).toBeNull();
        expect(restored.stories.filter((story) => story.revision === 2).every((story) => story.supersededAt !== null)).toBe(true);
        expect(restored.revisions![1].rejectedAt).toBeTypeOf('number');
        expect(restored.revisions![2].restoresRevision).toBe(1);
        expect(store.listEvents('program.material_revision_rejected')).toHaveLength(1);
        expect(store.list()[0].state).toBe('done');
        expect(github.issues.size).toBe(issuesBefore);
        const remaining = draft(); remaining.stories = [{ ...remaining.stories[1], dependsOn: [] }];
        const resumed = await coordinator.revise({ planId: restored.id, draft: remaining, assessment: nextAssessment, reason: 'wave-complete', material: false, summary: 'Continue approved work' });
        const next = resumed.stories.find((story) => story.revision === 4)!;
        expect(resumed.currentWave).toBe(2);
        expect(next.dependsOn).toEqual([approved.stories[0].key]);
        expect(next.normalizedIssueNumber).not.toBeNull();
        expect(resumed.stories.find((story) => story.key === approved.stories[1].key)?.supersededAt).not.toBeNull();
      }
      if (!['snapshot', 'legacy'].includes(scenario)) expect(github.issues.size).toBe(issuesBefore);
    } finally { store.close(); }
  });

  it.each(['empty', 'optional', 'security'])('keeps a program draft unapproved without required product gates: %s', async (kind) => {
    const config = defaultProjectConfig(makeTmp('portfolio-gate-root'), 'project', 'owner/project');
    config.program.enabled = true;
    config.intake.trustedAuthors.push('owner');
    config.gates = kind === 'empty' ? [] : [{ id: 'check', kind: kind === 'security' ? 'security' : 'unit', command: 'npm', args: ['test'], required: kind === 'security', timeoutMs: 1_000 }];
    const store = new PersistentTaskStore('portfolio-gate-project', makeTmp('portfolio-gate-state'));
    const github = new PortfolioGitHub();
    const coordinator = new PortfolioCoordinator(config, store, github);
    try {
      const created = await coordinator.createDraft({ sourcePath: 'PROJECT.md', content: 'objective', draft: draft() });
      const before = structuredClone(store.getPortfolioPlan(created.plan.id));
      const issuesBefore = structuredClone([...github.issues.values()]);
      await expect(coordinator.approve(created.plan.id)).rejects.toThrow('at least one required product verification gate');
      expect(store.getPortfolioPlan(created.plan.id)).toEqual(before);
      expect([...github.issues.values()]).toEqual(issuesBefore);
      expect(store.list()).toEqual([]);
      expect(before?.approvedAt).toBeNull();
    } finally { store.close(); }
  });

  it.each(['active', 'done', 'delivered', 'maintaining'] as const)('preserves idempotent approval for an existing %s program with legacy empty gates', async (status) => {
    const config = defaultProjectConfig(makeTmp('portfolio-existing-root'), 'project', 'owner/project');
    config.program.enabled = true;
    config.gates = [];
    const store = new PersistentTaskStore('portfolio-existing', makeTmp('portfolio-existing-state'));
    const coordinator = new PortfolioCoordinator(config, store, new PortfolioGitHub());
    try {
      const created = await coordinator.createDraft({ sourcePath: 'PROJECT.md', content: 'objective', draft: draft() });
      const existing = { ...created.plan, status, approvedAt: 1 };
      store.savePortfolioPlan(existing);
      expect(await coordinator.approve(existing.id)).toEqual(existing);
    } finally { store.close(); }
  });

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
    store.saveRepositoryAssessment(assessment);
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
    store.saveRepositoryAssessment(nextAssessment);
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
    // The repair is ingested and completed before the wave-complete revision.
    store.upsert({
      issueNumber: newRoot?.normalizedIssueNumber as number,
      title: 'recovered foundation',
      state: 'done',
      spec: parseNormalizedSpec((github.issues.get(newRoot?.normalizedIssueNumber as number) as RemoteIssue).body),
    });

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

  it.each(['mapped', 'separate', 'approved-new', 'subdetail', 'ambiguous', 'missing', 'renamed', 'reinterpreted', 'material', 'completed', 'active'])('maps recovery by requirement identity before any published effects: %s', async (scenario) => {
    const config = defaultProjectConfig(makeTmp('lineage-root'), 'project', 'owner/project');
    config.program.enabled = true;
    config.gates = [{ id: 'test', kind: 'unit', command: 'npm', args: ['test'], required: true, timeoutMs: 1_000 }];
    config.intake.trustedAuthors.push('owner');
    const store = new PersistentTaskStore('lineage-project', makeTmp('lineage-state'));
    const github = new PortfolioGitHub();
    const coordinator = new PortfolioCoordinator(config, store, github);
    try {
      const initial = draft();
      initial.stories[0]!.coverageIds = ['A'];
      initial.stories[1]!.coverageIds = ['B'];
      initial.stories[1]!.dependsOn = [];
      const assessment: RepositoryAssessment = {
        id: 'lineage-initial', projectId: store.projectId, commitSha: 'a'.repeat(40), dirty: false,
        detectedStacks: ['node'], files: [], analyses: [], createdAt: 1,
        coverage: ['Foundation', 'Feature', 'Independent'].map((requirement, index) => ({
          id: ['A', 'B', 'C'][index], requirement, status: 'missing', requiredAction: 'implement', rationale: 'Missing', evidence: [],
        })),
      };
      if (scenario === 'subdetail') assessment.coverage[0]!.requirement = 'Foundation. New capability must be delivered';
      store.saveRepositoryAssessment(assessment);
      const sourceContent = ['approved-new', 'subdetail'].includes(scenario)
        ? 'objective\n- Acceptance: New capability must be delivered'
        : 'objective';
      const created = await coordinator.createDraft({ sourcePath: 'PROJECT.md', content: sourceContent, draft: initial, assessment });
      let approved = await coordinator.approve(created.plan.id);
      const origins = approved.stories.map((story) => story.normalizedIssueNumber as number);
      origins.forEach((issueNumber) => store.upsert({ issueNumber, title: 'failed work', state: 'quarantined' }));
      if (scenario === 'completed' || scenario === 'active') {
        const recovery = { ...approved.stories[0]!, key: 'RECOVERY', revision: 2, normalizedIssueNumber: 999 };
        store.upsert({ issueNumber: 999, title: 'later recovery', state: scenario === 'completed' ? 'done' : 'active' });
        const second = { ...assessment, id: 'lineage-second' };
        store.saveRepositoryAssessment(second);
        approved = { ...approved, revision: 2, stories: [...approved.stories, recovery], revisions: [...approved.revisions!, { ...approved.revisions![0], number: 2, assessmentId: second.id }] };
        store.savePortfolioPlan(approved);
      }
      const replacement = draft();
      replacement.stories[0]!.coverageIds = ['C'];
      replacement.stories[1]!.coverageIds = ['NEW_A']; // A nonroot repair must inherit A, not independent C.
      const next = { ...assessment, id: 'lineage-next', coverage: [...assessment.coverage, { ...assessment.coverage[0], id: 'NEW_A', requirement: '  FOUNDATION  ' }] };
      if (scenario === 'separate') {
        replacement.stories[0]!.coverageIds = ['NEW_A'];
        replacement.stories[1]!.coverageIds = ['B'];
      }
      if (scenario === 'approved-new' || scenario === 'subdetail') next.coverage[next.coverage.length - 1].requirement = 'New capability must be delivered';
      if (scenario === 'missing') replacement.stories[1]!.coverageIds = [];
      if (scenario === 'ambiguous') replacement.stories[1]!.coverageIds = ['NEW_A', 'B'];
      if (scenario === 'renamed' || scenario === 'material') next.coverage[next.coverage.length - 1].requirement = 'A genuinely new or unresolvable requirement';
      if (scenario === 'reinterpreted') {
        replacement.stories[1]!.coverageIds = ['A'];
        next.coverage = next.coverage.map((entry) => entry.id === 'A' ? { ...entry, requirement: 'Different meaning' } : entry);
      }
      const before = store.getPortfolioPlan(approved.id);
      const issueCount = github.issues.size;
      const revise = () => coordinator.revise({ planId: approved.id, draft: replacement, assessment: next, reason: 'manual', material: scenario === 'material', summary: 'Recovery mapping' });
      if (['ambiguous', 'missing', 'renamed', 'reinterpreted', 'subdetail'].includes(scenario)) {
        await expect(revise()).rejects.toMatchObject({ name: 'RecoveryLineageError', storyKeys: ['S2'], assessmentId: next.id });
        expect(github.issues.size).toBe(issueCount);
        expect(store.getPortfolioPlan(approved.id)).toEqual(before);
      } else {
        const revised = await revise();
        const added = revised.stories.filter((story) => story.revision === (approved.revision ?? 1) + 1);
        expect(added[0].failureOriginIssueNumber).toBe(scenario === 'separate' ? origins[0] : null);
        expect(added[1].failureOriginIssueNumber).toBe(scenario === 'separate' ? origins[1] : ['mapped', 'active'].includes(scenario) ? origins[0] : null);
        if (scenario === 'material') expect(revised.status).toBe('awaiting_material_approval');
      }
      expect(new RecoveryLineageError('reason', ['S1'], origins, assessment.id)).toBeInstanceOf(Error);
    } finally { store.close(); }
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

  it('observes a projected blocked-to-active recovery without remote or store mutations', async () => {
    const root = makeTmp('portfolio-observe-root');
    const config = defaultProjectConfig(root, 'project', 'owner/project');
    config.program.enabled = true;
    config.intake.trustedAuthors.push('owner');
    config.gates = [{ id: 'test', kind: 'unit', command: 'npm', args: ['test'], required: true, timeoutMs: 1_000 }];
    const store = new PersistentTaskStore('portfolio-observe', makeTmp('portfolio-observe-state'));
    const github = new PortfolioGitHub();
    const coordinator = new PortfolioCoordinator(config, store, github);
    try {
      const created = await coordinator.createDraft({ sourcePath: 'PROJECT.md', content: 'objective', draft: draft() });
      const approved = await coordinator.approve(created.plan.id);
      const foundationIssue = approved.stories[0]!.normalizedIssueNumber!;
      const featureIssue = approved.stories[1]!.normalizedIssueNumber!;

      store.upsert({ issueNumber: foundationIssue, title: 'Foundation', state: 'failed' });
      const [blocked] = await coordinator.refresh(created.plan.id);
      expect(blocked?.status).toBe('blocked');
      expect(github.updateCalls).toContain(approved.epicIssueNumber);
      const epicBody = (github.issues.get(approved.epicIssueNumber!) as RemoteIssue).body;
      expect(epicBody).toContain('failed');

      // An approved recovery revision supersedes the failed wave story and
      // normalizes a replacement whose task is ready; the saved plan status is
      // still 'blocked' until reconciliation persists the recovery.
      const recoveryStory = {
        ...approved.stories[0]!, key: 'R2_S1', revision: 2, wave: 2, supersededAt: null as number | null,
        normalizedIssueNumber: 999, normalizedIssueUrl: 'https://github.test/owner/project/issues/999',
        sourceIssueNumber: 6, sourceIssueUrl: 'https://github.test/owner/project/issues/6',
      };
      store.savePortfolioPlan({
        ...approved,
        status: 'blocked',
        currentWave: 2,
        stories: [
          { ...approved.stories[0]!, supersededAt: Date.now() },
          approved.stories[1]!,
          recoveryStory,
        ],
      });
      store.upsert({ issueNumber: 999, title: 'Recovered foundation', state: 'ready' });
      const issuesBefore = structuredClone([...github.issues.values()]);
      const planBefore = structuredClone(store.getPortfolioPlan(created.plan.id));
      const eventsBefore = store.listEvents().length;
      github.updateCalls.length = 0;
      github.readCalls.length = 0;

      const [view] = coordinator.observe(created.plan.id);
      expect(view?.status).toBe('active');
      expect(view?.counts).toEqual({ ready: 1, 'awaiting-approval': 1 });
      expect(store.getPortfolioPlan(created.plan.id)).toEqual(planBefore);
      expect(store.listEvents()).toHaveLength(eventsBefore);
      expect([...github.issues.values()]).toEqual(issuesBefore);
      expect((github.issues.get(approved.epicIssueNumber!) as RemoteIssue).body).toBe(epicBody);
      expect(github.updateCalls).toHaveLength(0);
      expect(github.readCalls).toHaveLength(0);

      // The saved status stays untouched until an approved reconciliation path runs.
      expect(store.getPortfolioPlan(created.plan.id)?.status).toBe('blocked');
      const [reconciled] = await coordinator.refresh(created.plan.id);
      expect(reconciled?.status).toBe('active');
      expect(store.getPortfolioPlan(created.plan.id)?.status).toBe('active');
      void featureIssue;
    } finally { store.close(); }
  });

  it('observes an all-done program wave as assessing without persisting it', async () => {
    const root = makeTmp('portfolio-observe-wave-root');
    const config = defaultProjectConfig(root, 'project', 'owner/project');
    config.program.enabled = true;
    config.intake.trustedAuthors.push('owner');
    config.gates = [{ id: 'test', kind: 'unit', command: 'npm', args: ['test'], required: true, timeoutMs: 1_000 }];
    const store = new PersistentTaskStore('portfolio-observe-wave', makeTmp('portfolio-observe-wave-state'));
    const github = new PortfolioGitHub();
    const coordinator = new PortfolioCoordinator(config, store, github);
    try {
      const programDraft = draft();
      programDraft.stories[0]!.coverageIds = ['REQ1'];
      programDraft.stories[1]!.coverageIds = ['REQ2'];
      const assessment: RepositoryAssessment = {
        id: 'observe_wave', projectId: store.projectId, commitSha: 'a'.repeat(40), dirty: false,
        detectedStacks: ['node'], files: [], analyses: [],
        coverage: ['Foundation', 'Feature'].map((requirement, index) => ({
          id: `REQ${index + 1}`, requirement, status: 'missing' as const, requiredAction: 'implement' as const, rationale: 'Missing', evidence: [],
        })),
        createdAt: 1,
      };
      const created = await coordinator.createDraft({ sourcePath: 'PROJECT.md', content: 'objective', draft: programDraft, assessment });
      const approved = await coordinator.approve(created.plan.id);
      const waveIssue = approved.stories[0]!.normalizedIssueNumber!;
      store.upsert({ issueNumber: waveIssue, title: 'Foundation', state: 'done' });

      const planBefore = structuredClone(store.getPortfolioPlan(created.plan.id))!;
      expect(planBefore.status).toBe('active');
      const eventsBefore = store.listEvents().length;
      github.updateCalls.length = 0;

      const [view] = coordinator.observe(created.plan.id);
      expect(view?.status).toBe('assessing');
      expect(view?.counts).toEqual({ done: 1, 'awaiting-approval': 1 });
      expect(store.getPortfolioPlan(created.plan.id)).toEqual(planBefore);
      expect(store.listEvents()).toHaveLength(eventsBefore);
      expect(github.updateCalls).toHaveLength(0);

      // The saved status stays untouched until an approved reconciliation path runs.
      expect((await coordinator.refresh(created.plan.id))[0]?.status).toBe('assessing');
      expect(store.getPortfolioPlan(created.plan.id)?.status).toBe('assessing');
    } finally { store.close(); }
  });

  it('keeps the current wave when a manual reassessment leaves a ready current-wave task unstarted', async () => {
    const config = defaultProjectConfig(makeTmp('wave-manual-root'), 'project', 'owner/project');
    config.program.enabled = true;
    config.intake.trustedAuthors.push('owner');
    config.gates = [{ id: 'test', kind: 'unit', command: 'npm', args: ['test'], required: true, timeoutMs: 1_000 }];
    const store = new PersistentTaskStore('wave-manual', makeTmp('wave-manual-state'));
    const github = new PortfolioGitHub();
    const coordinator = new PortfolioCoordinator(config, store, github);
    try {
      const programDraft = draft();
      programDraft.stories[0]!.coverageIds = ['REQ1'];
      programDraft.stories[1]!.coverageIds = ['REQ2'];
      const assessment: RepositoryAssessment = {
        id: 'manual_1', projectId: store.projectId, commitSha: 'a'.repeat(40), dirty: false,
        detectedStacks: ['node'], files: [], analyses: [],
        coverage: ['Foundation', 'Feature'].map((requirement, index) => ({
          id: `REQ${index + 1}`, requirement, status: 'missing' as const, requiredAction: 'implement' as const, rationale: 'Missing', evidence: [],
        })),
        createdAt: 1,
      };
      store.saveRepositoryAssessment(assessment);
      const created = await coordinator.createDraft({ sourcePath: 'PROJECT.md', content: 'program objective', draft: programDraft, assessment });
      const approved = await coordinator.approve(created.plan.id);
      const foundationIssue = approved.stories[0]!.normalizedIssueNumber!;
      store.upsert({ issueNumber: foundationIssue, title: 'Foundation', state: 'ready' });

      const next = { ...assessment, id: 'manual_2', commitSha: 'b'.repeat(40), createdAt: 2 };
      store.saveRepositoryAssessment(next);
      const revised = await coordinator.revise({
        planId: created.plan.id, draft: programDraft, assessment: next,
        reason: 'manual', material: false, summary: 'Reassess without skipping the active wave',
      });

      expect(revised.currentWave).toBe(1);
      const prior = revised.stories.find((story) => story.key === approved.stories[0]!.key)!;
      expect(prior.normalizedIssueNumber).toBe(foundationIssue);
      expect(prior.supersededAt).toBeNull();
      expect(store.findByIssue(foundationIssue)?.state).toBe('ready');
      // New proposals stay unnormalized until their wave becomes current.
      const added = revised.stories.filter((story) => story.revision === 2);
      expect(added.length).toBeGreaterThan(0);
      expect(added.every((story) => story.normalizedIssueNumber === null)).toBe(true);
      expect(added.every((story) => (story.wave ?? 1) > 1)).toBe(true);
    } finally { store.close(); }
  });

  it('keeps the current wave when a published normalized issue has not been ingested into a task yet', async () => {
    const config = defaultProjectConfig(makeTmp('wave-unpublished-root'), 'project', 'owner/project');
    config.program.enabled = true;
    config.intake.trustedAuthors.push('owner');
    config.gates = [{ id: 'test', kind: 'unit', command: 'npm', args: ['test'], required: true, timeoutMs: 1_000 }];
    const store = new PersistentTaskStore('wave-unpublished', makeTmp('wave-unpublished-state'));
    const github = new PortfolioGitHub();
    const coordinator = new PortfolioCoordinator(config, store, github);
    try {
      const programDraft = draft();
      programDraft.stories[0]!.coverageIds = ['REQ1'];
      programDraft.stories[1]!.coverageIds = ['REQ2'];
      const assessment: RepositoryAssessment = {
        id: 'unpublished_1', projectId: store.projectId, commitSha: 'a'.repeat(40), dirty: false,
        detectedStacks: ['node'], files: [], analyses: [],
        coverage: ['Foundation', 'Feature'].map((requirement, index) => ({
          id: `REQ${index + 1}`, requirement, status: 'missing' as const, requiredAction: 'implement' as const, rationale: 'Missing', evidence: [],
        })),
        createdAt: 1,
      };
      store.saveRepositoryAssessment(assessment);
      const created = await coordinator.createDraft({ sourcePath: 'PROJECT.md', content: 'program objective', draft: programDraft, assessment });
      const approved = await coordinator.approve(created.plan.id);
      const foundationIssue = approved.stories[0]!.normalizedIssueNumber!;
      // Publication precedes intake: no task exists for the normalized issue yet.
      expect(store.findByIssue(foundationIssue)).toBeNull();

      const next = { ...assessment, id: 'unpublished_2', commitSha: 'b'.repeat(40), createdAt: 2 };
      store.saveRepositoryAssessment(next);
      const revised = await coordinator.revise({
        planId: created.plan.id, draft: programDraft, assessment: next,
        reason: 'manual', material: false, summary: 'Restart must not skip the published wave',
      });

      expect(revised.currentWave).toBe(1);
      const prior = revised.stories.find((story) => story.key === approved.stories[0]!.key)!;
      expect(prior.normalizedIssueNumber).toBe(foundationIssue);
      expect(prior.supersededAt).toBeNull();
      // New proposals stay unnormalized until their wave becomes current.
      const added = revised.stories.filter((story) => story.revision === 2);
      expect(added.length).toBeGreaterThan(0);
      expect(added.every((story) => story.normalizedIssueNumber === null)).toBe(true);
      expect(added.every((story) => (story.wave ?? 1) > 1)).toBe(true);

      // The issue remains eligible for later ingestion as a normal task.
      store.upsert({ issueNumber: foundationIssue, title: 'Foundation', state: 'ready' });
      expect(store.findByIssue(foundationIssue)?.state).toBe('ready');
      expect(github.issues.get(foundationIssue)).toBeDefined();
    } finally { store.close(); }
  });

  it('restores currentWave to the earliest unfinished wave after a controller advanced past it', async () => {
    const config = defaultProjectConfig(makeTmp('wave-restore-root'), 'project', 'owner/project');
    config.program.enabled = true;
    config.intake.trustedAuthors.push('owner');
    config.gates = [{ id: 'test', kind: 'unit', command: 'npm', args: ['test'], required: true, timeoutMs: 1_000 }];
    const store = new PersistentTaskStore('wave-restore', makeTmp('wave-restore-state'));
    const github = new PortfolioGitHub();
    const coordinator = new PortfolioCoordinator(config, store, github);
    try {
      const programDraft = draft();
      programDraft.stories[0]!.coverageIds = ['REQ1'];
      programDraft.stories[1]!.coverageIds = ['REQ2'];
      const assessment: RepositoryAssessment = {
        id: 'restore_1', projectId: store.projectId, commitSha: 'a'.repeat(40), dirty: false,
        detectedStacks: ['node'], files: [], analyses: [],
        coverage: ['Foundation', 'Feature'].map((requirement, index) => ({
          id: `REQ${index + 1}`, requirement, status: 'missing' as const, requiredAction: 'implement' as const, rationale: 'Missing', evidence: [],
        })),
        createdAt: 1,
      };
      store.saveRepositoryAssessment(assessment);
      const created = await coordinator.createDraft({ sourcePath: 'PROJECT.md', content: 'program objective', draft: programDraft, assessment });
      const approved = await coordinator.approve(created.plan.id);
      const foundationIssue = approved.stories[0]!.normalizedIssueNumber!;
      store.upsert({ issueNumber: foundationIssue, title: 'Foundation', state: 'ready' });

      // An older controller already activated wave 2 and normalized its story
      // while the wave-1 task was still outstanding.
      const feature = approved.stories[1]!;
      const earlyFeatureIssue = 999;
      store.savePortfolioPlan({
        ...approved,
        currentWave: 2,
        stories: approved.stories.map((story) => story.key === feature.key
          ? { ...story, normalizedIssueNumber: earlyFeatureIssue, normalizedIssueUrl: `https://github.test/owner/project/issues/${earlyFeatureIssue}` }
          : story),
      });
      store.upsert({ issueNumber: earlyFeatureIssue, title: 'Feature', state: 'active' });

      const next = { ...assessment, id: 'restore_2', commitSha: 'b'.repeat(40), createdAt: 2 };
      store.saveRepositoryAssessment(next);
      const revise = () => coordinator.revise({
        planId: created.plan.id, draft: programDraft, assessment: next,
        reason: 'manual', material: false, summary: 'Point the wave back at the outstanding verification',
      });

      const revised = await revise();
      expect(revised.currentWave).toBe(1);
      // Prior story contracts, issues, and tasks survive untouched.
      const restoredFoundation = revised.stories.find((story) => story.key === approved.stories[0]!.key)!;
      const restoredFeature = revised.stories.find((story) => story.key === feature.key)!;
      expect(restoredFoundation.normalizedIssueNumber).toBe(foundationIssue);
      expect(restoredFeature.normalizedIssueNumber).toBe(earlyFeatureIssue);
      expect(restoredFeature.supersededAt).toBeNull();
      expect(store.findByIssue(foundationIssue)?.state).toBe('ready');
      expect(store.findByIssue(earlyFeatureIssue)?.state).toBe('active');
      expect(github.issues.get(earlyFeatureIssue)).toBeUndefined(); // no issue deletion or rewrite
      const added = revised.stories.filter((story) => story.revision === 2);
      expect(added.every((story) => story.normalizedIssueNumber === null)).toBe(true);

      // Idempotent restart: revising again keeps pointing at the same wave.
      const again = await revise();
      expect(again.currentWave).toBe(1);
      expect(again.stories.find((story) => story.key === approved.stories[0]!.key)!.normalizedIssueNumber).toBe(foundationIssue);
    } finally { store.close(); }
  });

  it('still advances currentWave on a genuinely completed wave and preserves quarantine recovery', async () => {
    const config = defaultProjectConfig(makeTmp('wave-complete-root'), 'project', 'owner/project');
    config.program.enabled = true;
    config.intake.trustedAuthors.push('owner');
    config.gates = [{ id: 'test', kind: 'unit', command: 'npm', args: ['test'], required: true, timeoutMs: 1_000 }];
    const store = new PersistentTaskStore('wave-complete', makeTmp('wave-complete-state'));
    const github = new PortfolioGitHub();
    const coordinator = new PortfolioCoordinator(config, store, github);
    try {
      const programDraft = draft();
      programDraft.stories[0]!.coverageIds = ['REQ1'];
      programDraft.stories[1]!.coverageIds = ['REQ2'];
      const assessment: RepositoryAssessment = {
        id: 'complete_1', projectId: store.projectId, commitSha: 'a'.repeat(40), dirty: false,
        detectedStacks: ['node'], files: [], analyses: [],
        coverage: ['Foundation', 'Feature'].map((requirement, index) => ({
          id: `REQ${index + 1}`, requirement, status: 'missing' as const, requiredAction: 'implement' as const, rationale: 'Missing', evidence: [],
        })),
        createdAt: 1,
      };
      store.saveRepositoryAssessment(assessment);
      const created = await coordinator.createDraft({ sourcePath: 'PROJECT.md', content: 'program objective', draft: programDraft, assessment });
      const approved = await coordinator.approve(created.plan.id);
      const foundationIssue = approved.stories[0]!.normalizedIssueNumber!;
      store.upsert({ issueNumber: foundationIssue, title: 'Foundation', state: 'done' });

      const next = { ...assessment, id: 'complete_2', commitSha: 'b'.repeat(40), createdAt: 2 };
      store.saveRepositoryAssessment(next);
      const revised = await coordinator.revise({
        planId: created.plan.id, draft: programDraft, assessment: next,
        reason: 'manual', material: false, summary: 'Wave genuinely complete; advance normally',
      });
      expect(revised.currentWave).toBe(2);
      const waveTwo = revised.stories.filter((story) => story.revision === 2 && (story.wave ?? 1) === 2);
      expect(waveTwo.length).toBeGreaterThan(0);
      expect(waveTwo.every((story) => story.normalizedIssueNumber !== null)).toBe(true);
    } finally { store.close(); }
  });

  it('pins the wave for an approved material revision while an earlier wave is unfinished', async () => {
    const config = defaultProjectConfig(makeTmp('wave-material-root'), 'project', 'owner/project');
    config.program.enabled = true;
    config.intake.trustedAuthors.push('owner');
    config.gates = [{ id: 'test', kind: 'unit', command: 'npm', args: ['test'], required: true, timeoutMs: 1_000 }];
    const store = new PersistentTaskStore('wave-material', makeTmp('wave-material-state'));
    const github = new PortfolioGitHub();
    const coordinator = new PortfolioCoordinator(config, store, github);
    try {
      const programDraft = draft();
      programDraft.stories[0]!.coverageIds = ['REQ1'];
      programDraft.stories[1]!.coverageIds = ['REQ2'];
      const assessment: RepositoryAssessment = {
        id: 'material_1', projectId: store.projectId, commitSha: 'a'.repeat(40), dirty: false,
        detectedStacks: ['node'], files: [], analyses: [],
        coverage: ['Foundation', 'Feature'].map((requirement, index) => ({
          id: `REQ${index + 1}`, requirement, status: 'missing' as const, requiredAction: 'implement' as const, rationale: 'Missing', evidence: [],
        })),
        createdAt: 1,
      };
      store.saveRepositoryAssessment(assessment);
      const created = await coordinator.createDraft({ sourcePath: 'PROJECT.md', content: 'program objective', draft: programDraft, assessment });
      const approved = await coordinator.approve(created.plan.id);
      const foundationIssue = approved.stories[0]!.normalizedIssueNumber!;
      store.upsert({ issueNumber: foundationIssue, title: 'Foundation', state: 'ready' });

      const next = { ...assessment, id: 'material_2', commitSha: 'b'.repeat(40), createdAt: 2 };
      store.saveRepositoryAssessment(next);
      const revised = await coordinator.revise({
        planId: created.plan.id, draft: programDraft, assessment: next,
        reason: 'manual', material: true, approvedMaterial: true, summary: 'Approved material change must not skip the active wave',
      });

      // Approval boundary is preserved and the unfinished wave stays current.
      expect(revised.status).toBe('active');
      expect(revised.currentWave).toBe(1);
      const prior = revised.stories.find((story) => story.key === approved.stories[0]!.key)!;
      expect(prior.normalizedIssueNumber).toBe(foundationIssue);
      expect(prior.supersededAt).toBeNull();
      expect(store.findByIssue(foundationIssue)?.state).toBe('ready');
      const added = revised.stories.filter((story) => story.revision === 2);
      expect(added.length).toBeGreaterThan(0);
      expect(added.every((story) => story.normalizedIssueNumber === null)).toBe(true);
      expect(added.every((story) => (story.wave ?? 1) > 1)).toBe(true);
    } finally { store.close(); }
  });

  it('keeps a quarantined wave current while a ready sibling task remains in it', async () => {
    const config = defaultProjectConfig(makeTmp('wave-quarantine-sibling-root'), 'project', 'owner/project');
    config.program.enabled = true;
    config.intake.trustedAuthors.push('owner');
    config.gates = [{ id: 'test', kind: 'unit', command: 'npm', args: ['test'], required: true, timeoutMs: 1_000 }];
    const store = new PersistentTaskStore('wave-quarantine-sibling', makeTmp('wave-quarantine-sibling-state'));
    const github = new PortfolioGitHub();
    const coordinator = new PortfolioCoordinator(config, store, github);
    try {
      const programDraft = draft();
      programDraft.stories[0]!.coverageIds = ['REQ1'];
      programDraft.stories[1]!.coverageIds = ['REQ2'];
      programDraft.stories[1]!.dependsOn = []; // independent sibling in wave 1
      const assessment: RepositoryAssessment = {
        id: 'qsibling_1', projectId: store.projectId, commitSha: 'a'.repeat(40), dirty: false,
        detectedStacks: ['node'], files: [], analyses: [],
        coverage: ['Foundation', 'Feature'].map((requirement, index) => ({
          id: `REQ${index + 1}`, requirement, status: 'missing' as const, requiredAction: 'implement' as const, rationale: 'Missing', evidence: [],
        })),
        createdAt: 1,
      };
      store.saveRepositoryAssessment(assessment);
      const created = await coordinator.createDraft({ sourcePath: 'PROJECT.md', content: 'program objective', draft: programDraft, assessment });
      const approved = await coordinator.approve(created.plan.id);
      const failedIssue = approved.stories[0]!.normalizedIssueNumber!;
      const siblingIssue = approved.stories[1]!.normalizedIssueNumber!;
      expect(approved.stories[1]!.wave).toBe(1);
      store.upsert({
        issueNumber: failedIssue, title: 'quarantined foundation', state: 'quarantined',
        spec: parseNormalizedSpec((github.issues.get(failedIssue) as RemoteIssue).body),
        identicalFailures: 3, lastFailureFingerprint: 'same-failure', lineageFailures: 3,
      });
      store.upsert({ issueNumber: siblingIssue, title: 'Feature', state: 'ready' });

      const next = { ...assessment, id: 'qsibling_2', commitSha: 'b'.repeat(40), createdAt: 2 };
      store.saveRepositoryAssessment(next);
      const revised = await coordinator.revise({
        planId: created.plan.id, draft: programDraft, assessment: next,
        reason: 'quarantine', material: false, summary: 'Quarantine repair must wait for the ready sibling',
      });

      // The wave with the ready sibling stays current; no future work activates early.
      expect(revised.currentWave).toBe(1);
      expect(revised.stories.find((story) => story.key === approved.stories[1]!.key)!.normalizedIssueNumber).toBe(siblingIssue);
      expect(store.findByIssue(siblingIssue)?.state).toBe('ready');
      const added = revised.stories.filter((story) => story.revision === 2);
      expect(added.length).toBeGreaterThan(0);
      expect(added.every((story) => story.normalizedIssueNumber === null)).toBe(true);
      expect(added.every((story) => (story.wave ?? 1) > 1)).toBe(true);
    } finally { store.close(); }
  });

  it('advances quarantine recovery when only terminal failed work remains in the wave', async () => {
    const config = defaultProjectConfig(makeTmp('wave-quarantine-terminal-root'), 'project', 'owner/project');
    config.program.enabled = true;
    config.intake.trustedAuthors.push('owner');
    config.gates = [{ id: 'test', kind: 'unit', command: 'npm', args: ['test'], required: true, timeoutMs: 1_000 }];
    const store = new PersistentTaskStore('wave-quarantine-terminal', makeTmp('wave-quarantine-terminal-state'));
    const github = new PortfolioGitHub();
    const coordinator = new PortfolioCoordinator(config, store, github);
    try {
      const programDraft = draft();
      programDraft.stories[0]!.coverageIds = ['REQ1'];
      programDraft.stories[1]!.coverageIds = ['REQ2'];
      const assessment: RepositoryAssessment = {
        id: 'qterminal_1', projectId: store.projectId, commitSha: 'a'.repeat(40), dirty: false,
        detectedStacks: ['node'], files: [], analyses: [],
        coverage: ['Foundation', 'Feature'].map((requirement, index) => ({
          id: `REQ${index + 1}`, requirement, status: 'missing' as const, requiredAction: 'implement' as const, rationale: 'Missing', evidence: [],
        })),
        createdAt: 1,
      };
      store.saveRepositoryAssessment(assessment);
      const created = await coordinator.createDraft({ sourcePath: 'PROJECT.md', content: 'program objective', draft: programDraft, assessment });
      const approved = await coordinator.approve(created.plan.id);
      const failedIssue = approved.stories[0]!.normalizedIssueNumber!;
      store.upsert({
        issueNumber: failedIssue, title: 'failed foundation', state: 'failed',
        spec: parseNormalizedSpec((github.issues.get(failedIssue) as RemoteIssue).body),
        identicalFailures: 3, lastFailureFingerprint: 'same-failure', lineageFailures: 3,
      });

      const next = { ...assessment, id: 'qterminal_2', commitSha: 'b'.repeat(40), createdAt: 2 };
      store.saveRepositoryAssessment(next);
      const revised = await coordinator.revise({
        planId: created.plan.id, draft: programDraft, assessment: next,
        reason: 'quarantine', material: false, summary: 'Only terminal work remains; recover into the next wave',
      });

      expect(revised.currentWave).toBe(2);
      const replacement = revised.stories.find((story) => story.revision === 2 && story.dependsOn.length === 0)!;
      expect(replacement.normalizedIssueNumber).not.toBeNull();
    } finally { store.close(); }
  });

  it('observe() keeps absent-plan errors and reads only the requested plan', async () => {
    const root = makeTmp('portfolio-observe-filter-root');
    const config = defaultProjectConfig(root, 'project', 'owner/project');
    const store = new PersistentTaskStore('portfolio-observe-filter', makeTmp('portfolio-observe-filter-state'));
    const github = new PortfolioGitHub();
    const coordinator = new PortfolioCoordinator(config, store, github);
    try {
      const first = await coordinator.createDraft({ sourcePath: 'A.md', content: 'first objective', draft: draft() });
      const second = await coordinator.createDraft({ sourcePath: 'B.md', content: 'second objective', draft: draft() });
      const observed = coordinator.observe().map((view) => view.id);
      expect(observed).toHaveLength(2);
      expect(observed).toEqual(expect.arrayContaining([first.plan.id, second.plan.id]));
      expect(coordinator.observe(second.plan.id).map((view) => view.id)).toEqual([second.plan.id]);
      expect(() => coordinator.observe('plan_missing')).toThrow('Unknown portfolio plan: plan_missing');
    } finally { store.close(); }
  });
});
