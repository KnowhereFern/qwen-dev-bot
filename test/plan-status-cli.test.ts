import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  config: vi.fn(),
  listPlans: vi.fn(),
  getPlan: vi.fn(),
  listTasks: vi.fn(),
  close: vi.fn(),
  octokitConstructed: vi.fn(),
  tokenResolved: vi.fn(),
}));
vi.mock('../src/core/config.js', async (original) => ({
  ...await original<typeof import('../src/core/config.js')>(),
  loadProjectConfig: mock.config,
}));
vi.mock('../src/core/persistent-store.js', () => ({
  PersistentTaskStore: class {
    projectId = 'plan-project';
    listPortfolioPlans = mock.listPlans;
    getPortfolioPlan = mock.getPlan;
    list = mock.listTasks;
    close = mock.close;
  },
}));
vi.mock('../src/github/control-plane.js', () => ({
  OctokitControlPlane: class {
    constructor() { mock.octokitConstructed(); throw new Error('plan-status must not construct a GitHub control plane'); }
  },
  resolveGitHubToken: () => {
    mock.tokenResolved();
    throw new Error('plan-status must not resolve a GitHub token');
  },
}));
import { main } from '../src/cli.js';

function planFixture(status: string) {
  return {
    id: 'plan_x', projectId: 'plan-project', sourcePath: 'PROJECT.md', contentHash: 'a'.repeat(64),
    sourceContent: 'objective', title: 'Demo', objective: 'objective', constraints: [], definitionOfDone: [],
    technologyDecisions: [], deploymentDecisions: [], status, epicIssueNumber: 1, epicIssueUrl: 'u',
    stories: [
      {
        key: 'S1', title: 'Foundation', goal: 'g', acceptanceCriteria: [], constraints: [], requiredGateIds: [],
        rewardCriterionIds: [], risk: 'low', workType: 'implement', dependsOn: [], rollback: 'r',
        technologyDecisionIds: [], deploymentDecisionIds: [], revision: 1, supersededAt: null,
        sourceIssueNumber: 2, sourceIssueUrl: 'u', normalizedIssueNumber: 7, normalizedIssueUrl: 'u', wave: 1,
      },
    ],
    createdAt: 1, updatedAt: 1, approvedAt: 1, assessmentId: null, repositorySha: null, revision: 1,
    currentWave: 1, coverage: [], revisions: [], latestDeploymentId: null, deliveredAt: null,
    maintenanceStartedAt: null,
  };
}

describe('plan-status command', () => {
  let logs: string[];
  beforeEach(() => {
    vi.clearAllMocks();
    mock.config.mockReturnValue({ project: { name: 'plan', root: '/tmp/plan-project', githubRepo: 'owner/plan' }, program: { enabled: false } });
    mock.listPlans.mockReturnValue([]);
    mock.getPlan.mockReturnValue(undefined);
    mock.listTasks.mockReturnValue([]);
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => { logs.push(values.join(' ')); });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('projects blocked-to-active recovery locally without any GitHub access or store writes', async () => {
    mock.listPlans.mockReturnValue([planFixture('blocked')]);
    mock.listTasks.mockReturnValue([{ issueNumber: 7, state: 'ready' }]);

    expect(await main(['plan-status', '/tmp/plan-project', '--json'])).toBe(0);

    expect(mock.octokitConstructed).not.toHaveBeenCalled();
    expect(mock.tokenResolved).not.toHaveBeenCalled();
    const view = JSON.parse(logs.join('\n'));
    expect(view).toHaveLength(1);
    expect(view[0].status).toBe('active');
    expect(view[0].counts).toEqual({ ready: 1 });
    expect(view[0].stories[0].state).toBe('ready');
    expect(mock.close).toHaveBeenCalledOnce();
  });

  it('projects an all-done program wave as assessing', async () => {
    mock.config.mockReturnValue({ project: { name: 'plan', root: '/tmp/plan-project', githubRepo: 'owner/plan' }, program: { enabled: true } });
    const plan = { ...planFixture('active'), currentWave: 2 };
    plan.stories.push({ ...plan.stories[0], key: 'S2', wave: 2, normalizedIssueNumber: 8, revision: 2 });
    mock.getPlan.mockReturnValue(plan);
    mock.listTasks.mockReturnValue([{ issueNumber: 8, state: 'done' }]);

    expect(await main(['plan-status', '/tmp/plan-project', '--plan', 'plan_x', '--json'])).toBe(0);

    expect(mock.getPlan).toHaveBeenCalledWith('plan_x');
    expect(mock.listPlans).not.toHaveBeenCalled();
    const [view] = JSON.parse(logs.join('\n'));
    expect(view.status).toBe('assessing');
    expect(view.counts).toEqual({ done: 1, 'awaiting-supervisor': 1 });
  });

  it('still filters --plan and preserves the absent-plan error', async () => {
    mock.listPlans.mockReturnValue([planFixture('draft')]);
    await expect(main(['plan-status', '/tmp/plan-project', '--plan', 'plan_missing', '--json'])).rejects.toThrow('Unknown portfolio plan: plan_missing');
    expect(mock.getPlan).toHaveBeenCalledWith('plan_missing');
    expect(mock.listPlans).not.toHaveBeenCalled();
    expect(mock.close).toHaveBeenCalled();
  });
});
