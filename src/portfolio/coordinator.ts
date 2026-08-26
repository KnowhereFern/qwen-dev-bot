import { createHash } from 'node:crypto';
import type { PersistentTaskStore } from '../core/persistent-store.js';
import type { PortfolioPlan, PortfolioStory, ProjectConfig, TaskRecord, TaskSpec } from '../core/types.js';
import type { GitHubControl, RemoteIssue } from '../github/control-plane.js';
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
      title: input.draft.title,
      objective: input.draft.objective,
      constraints: [...input.draft.constraints],
      definitionOfDone: [...input.draft.definitionOfDone],
      status: 'draft',
      epicIssueNumber: null,
      epicIssueUrl: null,
      stories: input.draft.stories.map((story): PortfolioStory => ({
        ...story,
        sourceIssueNumber: null,
        sourceIssueUrl: null,
        normalizedIssueNumber: null,
        normalizedIssueUrl: null,
      })),
      createdAt: now,
      updatedAt: now,
      approvedAt: null,
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
    if (plan.status === 'done' || plan.status === 'active') return plan;
    if (plan.status === 'blocked') {
      throw new Error(`Portfolio plan ${plan.id} is blocked; resolve its failed tasks before approving another revision`);
    }
    if (!['draft', 'approving'].includes(plan.status)) {
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
    for (const story of plan.stories) {
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
      };
      const body = `${renderNormalizedBody(source, spec)}\n\n<!-- ${NORMALIZED_STORY_MARKER} ${plan.id}:${story.key} -->`;
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
    plan = this.save({ ...plan, status: 'active', updatedAt: Date.now() });
    await this.updateEpic(plan);
    return plan;
  }

  async refresh(planId?: string): Promise<PortfolioPlan[]> {
    const plans = planId ? [this.requirePlan(planId)] : this.store.listPortfolioPlans();
    const tasks = this.store.list();
    const refreshed: PortfolioPlan[] = [];
    for (const existing of plans) {
      let plan = await this.recoverRemoteIssues(existing);
      if (['active', 'blocked'].includes(plan.status)) {
        const storyStates = plan.stories.map((story) => taskForStory(story, tasks)?.state ?? null);
        const failures = storyStates.some((state) => state !== null && ['failed', 'quarantined', 'cancelled'].includes(state));
        const allDone = storyStates.length > 0 && storyStates.every((state) => state === 'done');
        const status = allDone ? 'done' : failures ? 'blocked' : 'active';
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
      input.stories.every((story) => story.sourceIssueNumber !== null && (input.status === 'draft' || story.normalizedIssueNumber !== null))
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
  stories: Array<{
    key: string;
    title: string;
    dependencies: string[];
    sourceIssueNumber: number | null;
    normalizedIssueNumber: number | null;
    taskId: string | null;
    state: string;
  }>;
  counts: Record<string, number>;
}

export function formatPortfolioPlan(view: PortfolioPlanView): string {
  return [
    `${view.id}  ${view.status}  ${view.title}`,
    `Source: ${view.sourcePath} (${view.contentHash.slice(0, 12)})`,
    `Epic: ${view.epicIssueNumber ? `#${view.epicIssueNumber}` : 'not published'}`,
    `Counts: ${JSON.stringify(view.counts)}`,
    '',
    ...view.stories.map(
      (story) =>
        `${story.key.padEnd(8)} ${story.state.padEnd(20)} source=${story.sourceIssueNumber ? `#${story.sourceIssueNumber}` : '-'} ` +
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
  };
  const actual = {
    ...spec,
    source: { kind: spec.source.kind, url: spec.source.url },
  };
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function renderEpic(plan: PortfolioPlan, tasks: TaskRecord[]): string {
  const statusNote = plan.status === 'draft'
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
    '',
    '## Definition of done',
    ...plan.definitionOfDone.map((item) => `- [ ] ${item}`),
    '',
    '## Constraints',
    ...(plan.constraints.length ? plan.constraints.map((item) => `- ${item}`) : ['- None declared.']),
    '',
    '## Delivery graph',
    ...plan.stories.map((story) => {
      const task = taskForStory(story, tasks);
      const state = task?.state ?? (story.normalizedIssueNumber ? 'awaiting-supervisor' : 'awaiting-approval');
      const link = story.sourceIssueUrl ? `[${story.key} ${story.title}](${story.sourceIssueUrl})` : `${story.key} ${story.title}`;
      const dependencies = story.dependsOn.length ? `; depends on ${story.dependsOn.join(', ')}` : '';
      return `- [${state === 'done' ? 'x' : ' '}] ${link} — ${state}${dependencies}`;
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
    `Required gates: ${story.requiredGateIds.join(', ') || '(none)'}`,
    `Reward criteria: ${story.rewardCriterionIds.join(', ') || '(none)'}`,
    `Risk: **${story.risk}**`,
    `Rollback: ${story.rollback}`,
    '',
    `Source requirements: \`${plan.sourcePath}\` at \`${plan.contentHash}\``,
    `<!-- ${STORY_MARKER} ${plan.id}:${story.key} -->`,
  ].join('\n');
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
