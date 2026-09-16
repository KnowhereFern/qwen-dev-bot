import { createHash } from 'node:crypto';
import type { PersistentTaskStore } from '../core/persistent-store.js';
import type {
  PortfolioPlan,
  PortfolioStory,
  ProgramRevision,
  ProjectConfig,
  RepositoryAssessment,
  TaskRecord,
  TaskSpec,
} from '../core/types.js';
import type { GitHubControl } from '../github/control-plane.js';
import { renderNormalizedBody } from '../intake/normalizer.js';
import type { PortfolioDraft } from './planner.js';

const PLAN_MARKER = 'qwen-harness-plan:v1';
const STORY_MARKER = 'qwen-harness-plan-story:v1';
const NORMALIZED_STORY_MARKER = 'qwen-harness-plan-normalized:v1';

export class PortfolioCoordinator {
  constructor(
    private readonly config: ProjectConfig,
    private readonly store: PersistentTaskStore,
    private readonly github: GitHubControl,
  ) {}

  async findByRequirements(content: string): Promise<PortfolioPlan | null> {
    const existing = this.store.findPortfolioPlanByHash(sha256(content));
    return existing ? this.publishDraft(await this.recoverRemoteIssues(existing)) : null;
  }

  async createDraft(input: {
    sourcePath: string;
    content: string;
    draft: PortfolioDraft;
    assessment?: RepositoryAssessment;
  }): Promise<{ plan: PortfolioPlan; created: boolean }> {
    const contentHash = sha256(input.content);
    const existing = this.store.findPortfolioPlanByHash(contentHash);
    if (existing) {
      const plan = await this.publishDraft(await this.recoverRemoteIssues(existing));
      return { plan, created: false };
    }

    const now = Date.now();
    const plan: PortfolioPlan = {
      id: `plan_${sha256(`${this.store.projectId}:${contentHash}`).slice(0, 20)}`,
      projectId: this.store.projectId,
      sourcePath: input.sourcePath,
      contentHash,
      sourceContent: input.content,
      title: input.draft.title,
      objective: input.draft.objective,
      constraints: [...input.draft.constraints],
      definitionOfDone: [...input.draft.definitionOfDone],
      technologyDecisions: structuredClone(input.draft.technologyDecisions),
      deploymentDecisions: structuredClone(input.draft.deploymentDecisions),
      status: this.config.program.enabled ? 'awaiting_initial_approval' : 'draft',
      epicIssueNumber: null,
      epicIssueUrl: null,
      stories: assignWaves(input.draft.stories).map((story): PortfolioStory => ({
        ...story,
        revision: 1,
        supersededAt: null,
        sourceIssueNumber: null,
        sourceIssueUrl: null,
        normalizedIssueNumber: null,
        normalizedIssueUrl: null,
      })),
      createdAt: now,
      updatedAt: now,
      approvedAt: null,
      assessmentId: input.assessment?.id ?? null,
      repositorySha: input.assessment?.commitSha ?? null,
      revision: 1,
      currentWave: 1,
      coverage: structuredClone(input.assessment?.coverage ?? []),
      revisions: input.assessment ? [{
        number: 1,
        assessmentId: input.assessment.id,
        repositorySha: input.assessment.commitSha,
        reason: 'initial',
        material: false,
        summary: 'Initial repository-aware delivery program',
        createdAt: now,
        approvedAt: null,
      }] : [],
      latestDeploymentId: null,
      deliveredAt: null,
      maintenanceStartedAt: null,
    };
    this.store.savePortfolioPlan(plan);
    this.store.recordEvent('portfolio.created', null, {
      planId: plan.id,
      sourcePath: plan.sourcePath,
      contentHash: plan.contentHash,
      storyCount: plan.stories.length,
    }, `portfolio:create:${plan.id}`);
    return { plan: await this.publishDraft(plan), created: true };
  }

  async approve(planId: string): Promise<PortfolioPlan> {
    let plan = this.requirePlan(planId);
    if (['done', 'delivered', 'maintaining', 'active'].includes(plan.status)) return plan;
    if (plan.status === 'blocked') {
      throw new Error(`Portfolio plan ${plan.id} is blocked; resolve its failed tasks before approving another revision`);
    }
    if (!['draft', 'awaiting_initial_approval', 'awaiting_material_approval', 'approving'].includes(plan.status)) {
      throw new Error(`Portfolio plan ${plan.id} cannot be approved from ${plan.status}`);
    }
    const conflicting = this.store.listPortfolioPlans().find(
      (candidate) =>
        candidate.id !== plan.id &&
        candidate.sourcePath === plan.sourcePath &&
        ['approving', 'active', 'blocked'].includes(candidate.status),
    );
    if (conflicting) {
      throw new Error(
        `Portfolio plan ${conflicting.id} already controls ${plan.sourcePath}; finish or resolve it before approving a revision`,
      );
    }
    const actor = await this.github.currentUser();
    if (!this.config.intake.trustedAuthors.includes(actor)) {
      throw new Error(
        `GitHub user ${actor} is not in intake.trustedAuthors; rerun setup/update with --trusted-author ${actor}`,
      );
    }

    plan = await this.publishDraft(await this.recoverRemoteIssues(plan));
    plan = this.save({
      ...plan,
      status: 'approving',
      approvedAt: plan.approvedAt ?? Date.now(),
      updatedAt: Date.now(),
    });
    plan = await this.publishExecutableStories(plan, this.config.program.enabled ? plan.currentWave ?? 1 : undefined);
    const revisions = (plan.revisions ?? []).map((revision) =>
      revision.number === (plan.revision ?? 1) && revision.approvedAt === null
        ? { ...revision, approvedAt: Date.now() }
        : revision,
    );
    plan = this.save({ ...plan, revisions, status: 'active', updatedAt: Date.now() });
    this.store.recordEvent('program.approved', null, {
      planId: plan.id,
      revision: plan.revision ?? 1,
      material: revisions.find((revision) => revision.number === (plan.revision ?? 1))?.material ?? false,
    }, `program:approved:${plan.id}:${plan.revision ?? 1}`);
    await this.updateEpic(plan);
    return plan;
  }

  async activateWave(planId: string, wave: number): Promise<PortfolioPlan> {
    let plan = this.requirePlan(planId);
    if (!this.config.program.enabled) throw new Error('Dependency-wave activation requires program.enabled');
    if (wave !== (plan.currentWave ?? 1)) throw new Error(`Plan ${plan.id} expects wave ${plan.currentWave ?? 1}, not ${wave}`);
    plan = await this.publishDraft(await this.recoverRemoteIssues(plan));
    plan = await this.publishExecutableStories(plan, wave);
    plan = this.save({ ...plan, status: 'active', updatedAt: Date.now() });
    await this.updateEpic(plan);
    return plan;
  }

  async revise(input: {
    planId: string;
    draft: PortfolioDraft;
    assessment: RepositoryAssessment;
    reason: ProgramRevision['reason'];
    material: boolean;
    approvedMaterial?: boolean;
    sourceSignalId?: string;
    summary: string;
  }): Promise<PortfolioPlan> {
    const current = this.requirePlan(input.planId);
    if (!this.config.program.enabled) throw new Error('Program revision requires program.enabled');
    const nextRevision = (current.revision ?? 1) + 1;
    const now = Date.now();
    const preserved = current.stories.map((story) =>
      story.normalizedIssueNumber === null && (story.wave ?? 1) > (current.currentWave ?? 1)
        ? { ...story, supersededAt: story.supersededAt ?? now }
        : story,
    );
    const priorKeys = new Set(preserved.map((story) => story.key));
    const keyMap = new Map(input.draft.stories.map((story) => [story.key, uniqueRevisionKey(nextRevision, story.key, priorKeys)]));
    const priorWaveKeys = input.reason === 'quarantine' ? [] : current.stories
      .filter((story) => (story.wave ?? 1) === (current.currentWave ?? 1) && !story.supersededAt)
      .map((story) => story.key);
    const failureOriginIssueNumber = input.reason === 'quarantine'
      ? current.stories
          .filter((story) => (story.wave ?? 1) === (current.currentWave ?? 1))
          .map((story) => story.normalizedIssueNumber)
          .find((issueNumber) => issueNumber !== null && this.store.findByIssue(issueNumber)?.state === 'quarantined') ?? null
      : null;
    const revisedDrafts = input.draft.stories.map((story) => ({
      ...story,
      key: keyMap.get(story.key) as string,
      dependsOn: unique(story.dependsOn.map((key) => keyMap.get(key) ?? key)),
    }));
    const waves = assignWaves(revisedDrafts, current.currentWave ?? 1);
    const newStories = waves.map((story): PortfolioStory => ({
      ...story,
      dependsOn: unique([
        ...story.dependsOn,
        ...(story.dependsOn.length === 0 ? priorWaveKeys : []),
      ]),
      revision: nextRevision,
      supersededAt: null,
      failureOriginIssueNumber: story.dependsOn.length === 0 ? failureOriginIssueNumber : null,
      sourceIssueNumber: null,
      sourceIssueUrl: null,
      normalizedIssueNumber: null,
      normalizedIssueUrl: null,
    }));
    const revision: ProgramRevision = {
      number: nextRevision,
      assessmentId: input.assessment.id,
      repositorySha: input.assessment.commitSha,
      reason: input.reason,
      material: input.material,
      summary: input.summary,
      createdAt: now,
      approvedAt: input.material && !input.approvedMaterial ? null : now,
      sourceSignalId: input.sourceSignalId ?? null,
    };
    let plan = this.save({
      ...current,
      title: input.draft.title,
      constraints: unique([...current.constraints, ...input.draft.constraints]),
      definitionOfDone: unique([...current.definitionOfDone, ...input.draft.definitionOfDone]),
      technologyDecisions: input.material ? structuredClone(input.draft.technologyDecisions) : current.technologyDecisions,
      deploymentDecisions: input.material ? structuredClone(input.draft.deploymentDecisions) : current.deploymentDecisions,
      stories: [...preserved, ...newStories],
      assessmentId: input.assessment.id,
      repositorySha: input.assessment.commitSha,
      coverage: structuredClone(input.assessment.coverage),
      revision: nextRevision,
      currentWave: (current.currentWave ?? 1) + 1,
      revisions: [...(current.revisions ?? []), revision],
      status: input.material && !input.approvedMaterial ? 'awaiting_material_approval' : 'assessing',
      updatedAt: now,
    });
    plan = await this.publishDraft(plan);
    this.store.recordEvent('program.revised', null, {
      planId: plan.id,
      revision: nextRevision,
      material: input.material,
      assessmentId: input.assessment.id,
      storyCount: newStories.length,
    }, `program:revision:${plan.id}:${nextRevision}`);
    if (!input.material || input.approvedMaterial) plan = await this.activateWave(plan.id, plan.currentWave ?? 1);
    return plan;
  }

  async updateProgramState(
    planId: string,
    status: PortfolioPlan['status'],
    patch: Pick<Partial<PortfolioPlan>, 'latestDeploymentId' | 'deliveredAt' | 'maintenanceStartedAt' | 'repositorySha' | 'assessmentId' | 'coverage'> = {},
  ): Promise<PortfolioPlan> {
    const plan = this.save({ ...this.requirePlan(planId), ...patch, status, updatedAt: Date.now() });
    await this.updateEpic(plan);
    return plan;
  }

  private async publishExecutableStories(input: PortfolioPlan, wave?: number): Promise<PortfolioPlan> {
    const plan = structuredClone(input);
    for (const story of plan.stories) {
      if (story.supersededAt || (wave !== undefined && (story.wave ?? 1) !== wave)) continue;
      if (story.normalizedIssueNumber !== null) continue;
      if (story.sourceIssueNumber === null || story.sourceIssueUrl === null) {
        throw new Error(`Portfolio story ${story.key} has not been published for review`);
      }
      const dependencies = story.dependsOn.map((key) => {
        const dependency = plan.stories.find((candidate) => candidate.key === key);
        if (!dependency?.sourceIssueNumber) throw new Error(`Portfolio story ${story.key} dependency ${key} is unpublished`);
        return dependency.sourceIssueNumber;
      });
      const source = await this.github.getIssue(story.sourceIssueNumber);
      const spec: TaskSpec = {
        goal: story.goal,
        source: { kind: 'developer', url: source.url, author: source.author },
        acceptanceCriteria: [...story.acceptanceCriteria],
        constraints: unique([...plan.constraints, ...story.constraints]),
        requiredGateIds: [...story.requiredGateIds],
        rewardCriterionIds: [...story.rewardCriterionIds],
        risk: story.risk,
        dependencies,
        rollback: story.rollback,
        technologyDecisions: technologyDecisionsFor(plan, story),
        deploymentDecisions: deploymentDecisionsFor(plan, story),
      };
      const lineage = story.failureOriginIssueNumber ? `\n\nOrigin task: #${story.failureOriginIssueNumber}` : '';
      const body = `${renderNormalizedBody(source, spec)}${lineage}\n\n<!-- ${NORMALIZED_STORY_MARKER} ${plan.id}:${story.key} -->`;
      const normalized = await this.github.createIssue({
        title: `[harness] ${story.title}`,
        body,
        labels: [this.config.intake.normalizedLabel, this.config.intake.readyLabel],
      });
      story.normalizedIssueNumber = normalized.number;
      story.normalizedIssueUrl = normalized.url;
      plan.updatedAt = Date.now();
      this.store.savePortfolioPlan(plan);
      this.store.recordEvent('portfolio.story_approved', null, {
        planId: plan.id,
        storyKey: story.key,
        sourceIssue: source.number,
        normalizedIssue: normalized.number,
      }, `portfolio:approve:${plan.id}:${story.key}`);
    }
    return plan;
  }

  async refresh(planId?: string): Promise<PortfolioPlan[]> {
    const plans = planId ? [this.requirePlan(planId)] : this.store.listPortfolioPlans();
    const tasks = this.store.list();
    const refreshed: PortfolioPlan[] = [];
    for (const existing of plans) {
      let plan = await this.recoverRemoteIssues(existing);
      if (['active', 'blocked'].includes(plan.status)) {
        const activeStories = this.config.program.enabled
          ? plan.stories.filter((story) => !story.supersededAt && (story.wave ?? 1) === (plan.currentWave ?? 1))
          : plan.stories;
        const storyStates = activeStories.map((story) => taskForStory(story, tasks)?.state ?? null);
        const failures = storyStates.some((state) => state !== null && ['failed', 'quarantined', 'cancelled'].includes(state));
        const allDone = storyStates.length > 0 && storyStates.every((state) => state === 'done');
        const status = allDone ? (this.config.program.enabled ? 'assessing' : 'done') : failures ? 'blocked' : 'active';
        if (status !== plan.status) plan = this.save({ ...plan, status, updatedAt: Date.now() });
      }
      await this.updateEpic(plan, tasks);
      refreshed.push(plan);
    }
    return refreshed;
  }

  status(plan: PortfolioPlan, tasks = this.store.list()): PortfolioPlanView {
    const stories = plan.stories.map((story) => {
      const task = taskForStory(story, tasks);
      return {
        key: story.key,
        title: story.title,
        dependencies: [...story.dependsOn],
        sourceIssueNumber: story.sourceIssueNumber,
        normalizedIssueNumber: story.normalizedIssueNumber,
        taskId: task?.id ?? null,
        state: task?.state ?? (story.normalizedIssueNumber ? 'awaiting-supervisor' : 'awaiting-approval'),
        wave: story.wave ?? 1,
        revision: story.revision ?? 1,
        superseded: Boolean(story.supersededAt),
      };
    });
    return {
      id: plan.id,
      title: plan.title,
      sourcePath: plan.sourcePath,
      contentHash: plan.contentHash,
      status: plan.status,
      epicIssueNumber: plan.epicIssueNumber,
      approvedAt: plan.approvedAt,
      revision: plan.revision ?? 1,
      currentWave: plan.currentWave ?? 1,
      repositorySha: plan.repositorySha ?? null,
      assessmentId: plan.assessmentId ?? null,
      coverage: structuredClone(plan.coverage ?? []),
      latestDeploymentId: plan.latestDeploymentId ?? null,
      stories,
      counts: countStates(stories.map((story) => story.state)),
    };
  }

  private async publishDraft(input: PortfolioPlan): Promise<PortfolioPlan> {
    let plan = input;
    if (plan.epicIssueNumber === null) {
      const epic = await this.github.createIssue({
        title: `[harness plan] ${plan.title}`,
        body: renderEpic(plan, []),
        labels: [this.config.intake.planLabel],
      });
      plan = this.save({
        ...plan,
        epicIssueNumber: epic.number,
        epicIssueUrl: epic.url,
        updatedAt: Date.now(),
      });
    }
    for (const story of plan.stories) {
      if (story.sourceIssueNumber !== null) continue;
      const issue = await this.github.createIssue({
        title: `[${story.key}] ${story.title}`,
        body: renderStory(plan, story),
        labels: [this.config.intake.plannedLabel],
      });
      story.sourceIssueNumber = issue.number;
      story.sourceIssueUrl = issue.url;
      plan.updatedAt = Date.now();
      this.store.savePortfolioPlan(plan);
      this.store.recordEvent('portfolio.story_published', null, {
        planId: plan.id,
        storyKey: story.key,
        issueNumber: issue.number,
      }, `portfolio:publish:${plan.id}:${story.key}`);
    }
    await this.updateEpic(plan);
    return plan;
  }

  private async recoverRemoteIssues(input: PortfolioPlan): Promise<PortfolioPlan> {
    if (
      input.epicIssueNumber !== null &&
      input.stories.every((story) => story.sourceIssueNumber !== null)
    ) {
      return input;
    }
    const issues = await this.github.listOpenIssues();
    let changed = false;
    const plan = structuredClone(input);
    const epic = issues.find((issue) => issue.body.includes(`<!-- ${PLAN_MARKER} ${plan.id} -->`));
    if (plan.epicIssueNumber === null && epic) {
      plan.epicIssueNumber = epic.number;
      plan.epicIssueUrl = epic.url;
      changed = true;
    }
    for (const story of plan.stories) {
      const source = issues.find((issue) => issue.body.includes(`<!-- ${STORY_MARKER} ${plan.id}:${story.key} -->`));
      if (story.sourceIssueNumber === null && source) {
        story.sourceIssueNumber = source.number;
        story.sourceIssueUrl = source.url;
        changed = true;
      }
      const normalized = issues.find((issue) =>
        issue.body.includes(`<!-- ${NORMALIZED_STORY_MARKER} ${plan.id}:${story.key} -->`),
      );
      if (story.normalizedIssueNumber === null && normalized) {
        story.normalizedIssueNumber = normalized.number;
        story.normalizedIssueUrl = normalized.url;
        changed = true;
      }
    }
    return changed ? this.save({ ...plan, updatedAt: Date.now() }) : input;
  }

  private async updateEpic(plan: PortfolioPlan, tasks = this.store.list()): Promise<void> {
    if (plan.epicIssueNumber === null) return;
    const body = renderEpic(plan, tasks);
    const current = await this.github.getIssue(plan.epicIssueNumber);
    if (current.body !== body) await this.github.updateIssue(plan.epicIssueNumber, { body });
  }

  private requirePlan(id: string): PortfolioPlan {
    const plan = this.store.getPortfolioPlan(id);
    if (!plan) throw new Error(`Unknown portfolio plan: ${id}`);
    return plan;
  }

  private save(plan: PortfolioPlan): PortfolioPlan {
    return this.store.savePortfolioPlan(plan);
  }
}

export interface PortfolioPlanView {
  id: string;
  title: string;
  sourcePath: string;
  contentHash: string;
  status: PortfolioPlan['status'];
  epicIssueNumber: number | null;
  approvedAt: number | null;
  revision: number;
  currentWave: number;
  repositorySha: string | null;
  assessmentId: string | null;
  coverage: PortfolioPlan['coverage'];
  latestDeploymentId: string | null;
  stories: Array<{
    key: string;
    title: string;
    dependencies: string[];
    sourceIssueNumber: number | null;
    normalizedIssueNumber: number | null;
    taskId: string | null;
    state: string;
    wave: number;
    revision: number;
    superseded: boolean;
  }>;
  counts: Record<string, number>;
}

export function formatPortfolioPlan(view: PortfolioPlanView): string {
  return [
    `${view.id}  ${view.status}  ${view.title}`,
    `Source: ${view.sourcePath} (${view.contentHash.slice(0, 12)})`,
    `Epic: ${view.epicIssueNumber ? `#${view.epicIssueNumber}` : 'not published'}`,
    `Revision: ${view.revision}; wave: ${view.currentWave}; repository: ${view.repositorySha?.slice(0, 12) ?? 'unassessed'}`,
    `Assessment: ${view.assessmentId ?? 'none'}; deployment: ${view.latestDeploymentId ?? 'none'}`,
    `Coverage: ${JSON.stringify(countCoverage(view.coverage ?? []))}`,
    `Counts: ${JSON.stringify(view.counts)}`,
    '',
    ...view.stories.map(
      (story) =>
        `${story.key.padEnd(12)} wave=${story.wave} rev=${story.revision} ${story.superseded ? 'superseded' : story.state.padEnd(20)} source=${story.sourceIssueNumber ? `#${story.sourceIssueNumber}` : '-'} ` +
        `task=${story.normalizedIssueNumber ? `#${story.normalizedIssueNumber}` : '-'}${story.dependencies.length ? ` deps=[${story.dependencies.join(',')}]` : ''}  ${story.title}`,
    ),
  ].join('\n');
}

export function matchesPortfolioTaskContract(
  plan: PortfolioPlan,
  story: PortfolioStory,
  spec: TaskSpec,
): boolean {
  if (story.sourceIssueNumber === null || story.sourceIssueUrl === null) return false;
  const dependencyIssues = story.dependsOn.map((key) =>
    plan.stories.find((candidate) => candidate.key === key)?.sourceIssueNumber ?? null,
  );
  if (dependencyIssues.some((issueNumber) => issueNumber === null)) return false;
  const expected = {
    goal: story.goal,
    source: { kind: 'developer', url: story.sourceIssueUrl },
    acceptanceCriteria: story.acceptanceCriteria,
    constraints: unique([...plan.constraints, ...story.constraints]),
    requiredGateIds: story.requiredGateIds,
    rewardCriterionIds: story.rewardCriterionIds,
    risk: story.risk,
    dependencies: dependencyIssues,
    rollback: story.rollback,
    technologyDecisions: technologyDecisionsFor(plan, story),
    deploymentDecisions: deploymentDecisionsFor(plan, story),
  };
  const actual = {
    ...spec,
    source: { kind: spec.source.kind, url: spec.source.url },
  };
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function renderEpic(plan: PortfolioPlan, tasks: TaskRecord[]): string {
  const statusNote = ['draft', 'awaiting_initial_approval'].includes(plan.status)
    ? 'Review-only draft. No story is executable until `qwen-harness plan-approve` is run explicitly.'
    : `Plan status: **${plan.status}**.`;
  return [
    statusNote,
    '',
    '## Objective',
    plan.objective,
    '',
    '## Source',
    `- Project file: \`${plan.sourcePath}\``,
    `- SHA-256: \`${plan.contentHash}\``,
    `- Repository commit: \`${plan.repositorySha ?? 'not assessed'}\``,
    `- Program revision: ${plan.revision ?? 1}; current wave: ${plan.currentWave ?? 1}`,
    '',
    '## Objective coverage',
    ...((plan.coverage ?? []).length
      ? (plan.coverage ?? []).map((entry) => `- **${entry.status}** \`${entry.id}\` ${entry.requirement} — ${entry.rationale}`)
      : ['- Repository-aware coverage is not enabled for this legacy plan.']),
    '',
    '## Definition of done',
    ...plan.definitionOfDone.map((item) => `- [ ] ${item}`),
    '',
    '## Constraints',
    ...(plan.constraints.length ? plan.constraints.map((item) => `- ${item}`) : ['- None declared.']),
    '',
    '## Frozen technology decisions',
    ...(plan.technologyDecisions.length
      ? plan.technologyDecisions.map(
          (decision) =>
            `- \`${decision.id}\` ${decision.category}: **${decision.technology}** (${decision.source}) — ${decision.rationale}`,
        )
      : ['- None required.']),
    '',
    '## Frozen deployment decisions',
    ...(plan.deploymentDecisions.length
      ? plan.deploymentDecisions.map(
          (decision) =>
            `- \`${decision.id}\` ${decision.component}: **${decision.provider} / ${decision.environment}** — ${decision.authority}; ${decision.rationale}`,
        )
      : ['- None required.']),
    '',
    '> Plan approval freezes these decisions. Staging authority applies only when explicitly configured; production always requires approval.',
    '',
    '## Delivery graph',
    ...plan.stories.map((story) => {
      const task = taskForStory(story, tasks);
      const state = task?.state ?? (story.normalizedIssueNumber ? 'awaiting-supervisor' : 'awaiting-approval');
      const link = story.sourceIssueUrl ? `[${story.key} ${story.title}](${story.sourceIssueUrl})` : `${story.key} ${story.title}`;
      const dependencies = story.dependsOn.length ? `; depends on ${story.dependsOn.join(', ')}` : '';
      return `- [${state === 'done' ? 'x' : ' '}] ${link} — wave ${story.wave ?? 1}, revision ${story.revision ?? 1}, ${story.supersededAt ? 'superseded' : state}${dependencies}`;
    }),
    '',
    `<!-- ${PLAN_MARKER} ${plan.id} -->`,
  ].join('\n');
}

function renderStory(plan: PortfolioPlan, story: PortfolioStory): string {
  const dependencies = story.dependsOn.map((key) => {
    const dependency = plan.stories.find((candidate) => candidate.key === key);
    return dependency?.sourceIssueNumber ? `- #${dependency.sourceIssueNumber} (${key})` : `- ${key}`;
  });
  return [
    `Part of master plan #${plan.epicIssueNumber}. This issue is review-only until the plan is explicitly approved.`,
    '',
    '## Goal',
    story.goal,
    '',
    '## Acceptance criteria',
    ...story.acceptanceCriteria.map((item) => `- [ ] ${item}`),
    '',
    '## Constraints',
    ...unique([...plan.constraints, ...story.constraints]).map((item) => `- ${item}`),
    '',
    '## Dependencies',
    ...(dependencies.length ? dependencies : ['- None']),
    '',
    '## Frozen decisions for this story',
    ...renderStoryDecisions(plan, story),
    '',
    `Required gates: ${story.requiredGateIds.join(', ') || '(none)'}`,
    `Reward criteria: ${story.rewardCriterionIds.join(', ') || '(none)'}`,
    `Risk: **${story.risk}**`,
    `Rollback: ${story.rollback}`,
    `Objective coverage: ${story.coverageIds?.join(', ') || '(legacy plan)'}`,
    `Program wave: ${story.wave ?? 1}; revision: ${story.revision ?? 1}`,
    ...(story.failureOriginIssueNumber ? [`Failure lineage: origin task #${story.failureOriginIssueNumber}`] : []),
    '',
    `Source requirements: \`${plan.sourcePath}\` at \`${plan.contentHash}\`; repository \`${plan.repositorySha ?? 'unassessed'}\``,
    `<!-- ${STORY_MARKER} ${plan.id}:${story.key} -->`,
  ].join('\n');
}

function technologyDecisionsFor(plan: PortfolioPlan, story: PortfolioStory) {
  return plan.technologyDecisions
    .filter((decision) => story.technologyDecisionIds.includes(decision.id))
    .map((decision) => structuredClone(decision));
}

function deploymentDecisionsFor(plan: PortfolioPlan, story: PortfolioStory) {
  return plan.deploymentDecisions
    .filter((decision) => story.deploymentDecisionIds.includes(decision.id))
    .map((decision) => structuredClone(decision));
}

function renderStoryDecisions(plan: PortfolioPlan, story: PortfolioStory): string[] {
  const technologies = technologyDecisionsFor(plan, story).map(
    (decision) =>
      `- Technology \`${decision.id}\`: ${decision.category} = **${decision.technology}** (${decision.source}) — ${decision.rationale}`,
  );
  const deployments = deploymentDecisionsFor(plan, story).map(
    (decision) =>
      `- Deployment \`${decision.id}\`: ${decision.component} on **${decision.provider} / ${decision.environment}** — ${decision.authority}; ${decision.rationale}`,
  );
  return technologies.length || deployments.length
    ? [...technologies, ...deployments, '- Authority is limited to the approved task and configured staging target; production requires approval.']
    : ['- None.'];
}

function taskForStory(story: PortfolioStory, tasks: TaskRecord[]): TaskRecord | undefined {
  return story.normalizedIssueNumber === null
    ? undefined
    : tasks.find((task) => task.issueNumber === story.normalizedIssueNumber);
}

function countStates(states: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const state of states) counts[state] = (counts[state] ?? 0) + 1;
  return counts;
}

function countCoverage(coverage: NonNullable<PortfolioPlan['coverage']>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of coverage) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  return counts;
}

function assignWaves<T extends { key: string; dependsOn: string[] }>(stories: T[], offset = 0): Array<T & { wave: number }> {
  const waveByKey = new Map<string, number>();
  const remaining = new Map(stories.map((story) => [story.key, story]));
  while (remaining.size > 0) {
    let progressed = false;
    for (const story of stories) {
      if (!remaining.has(story.key)) continue;
      const dependencyWaves = story.dependsOn.map((key) => waveByKey.get(key));
      if (dependencyWaves.some((wave) => wave === undefined)) continue;
      const localDepth = dependencyWaves.length
        ? Math.max(...dependencyWaves.map((wave) => (wave as number) - offset)) + 1
        : 1;
      waveByKey.set(story.key, offset + localDepth);
      remaining.delete(story.key);
      progressed = true;
    }
    if (!progressed) throw new Error('Cannot assign dependency waves to a cyclic or incomplete program');
  }
  return stories.map((story) => ({ ...story, wave: waveByKey.get(story.key) as number }));
}

function uniqueRevisionKey(revision: number, key: string, existing: Set<string>): string {
  const prefix = `R${revision}_`;
  const base = `${prefix}${key}`.slice(0, 32);
  let candidate = base;
  let suffix = 2;
  while (existing.has(candidate)) {
    candidate = `${base.slice(0, 32 - String(suffix).length - 1)}_${suffix}`;
    suffix += 1;
  }
  existing.add(candidate);
  return candidate;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
