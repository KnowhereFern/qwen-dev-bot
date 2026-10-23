import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  clientOptions: [] as Array<Record<string, unknown>>,
  clientInstances: [] as Array<unknown>,
  plannerOptions: [] as Array<unknown[]>,
  assessorOptions: [] as Array<unknown[]>,
  findByRequirements: vi.fn(),
  createDraft: vi.fn(),
  replaceDraft: vi.fn(),
  approve: vi.fn(),
  coordinatorStatus: vi.fn(),
  assertCanRedraft: vi.fn(),
  plannerPlan: vi.fn(),
  assess: vi.fn(),
  scan: vi.fn(),
  saveRepositoryAssessment: vi.fn(),
  storeClose: vi.fn(),
}));
vi.mock('../src/core/config.js', async (original) => ({
  ...await original<typeof import('../src/core/config.js')>(),
  loadProjectConfig: mock.loadConfig,
}));
vi.mock('../src/qwen/qwen-api.js', () => ({
  QwenApiClient: class {
    constructor(options: Record<string, unknown>) { mock.clientOptions.push(options); mock.clientInstances.push(this); }
  },
}));
vi.mock('../src/qwen/credential-resolver.js', () => ({
  resolveQwenCredential: () => ({ apiKey: 'test-key', source: 'test' }),
  assertQwenCredentialCompatibility: vi.fn(),
  qwenCredentialCompatibilityProblem: () => null,
}));
vi.mock('../src/github/control-plane.js', () => ({
  OctokitControlPlane: class {},
  resolveGitHubToken: async () => 'token',
}));
vi.mock('../src/core/persistent-store.js', () => ({
  PersistentTaskStore: class {
    saveRepositoryAssessment = mock.saveRepositoryAssessment;
    getRepositoryAssessment = vi.fn(() => null);
    close = mock.storeClose;
  },
}));
vi.mock('../src/portfolio/coordinator.js', async (original) => ({
  ...await original<typeof import('../src/portfolio/coordinator.js')>(),
  PortfolioCoordinator: class {
    findByRequirements = mock.findByRequirements;
    createDraft = mock.createDraft;
    replaceUnapprovedDraft = mock.replaceDraft;
    approve = mock.approve;
    status = mock.coordinatorStatus;
    assertCanRedraft = mock.assertCanRedraft;
  },
}));
vi.mock('../src/portfolio/planner.js', async (original) => ({
  ...await original<typeof import('../src/portfolio/planner.js')>(),
  PortfolioPlanner: class {
    constructor(...options: unknown[]) { mock.plannerOptions.push(options); }
    plan = mock.plannerPlan;
  },
  readRequirementsDocument: vi.fn(() => ({ sourcePath: 'PROJECT.md', content: 'requirements' })),
}));
vi.mock('../src/program/repository-assessor.js', () => ({
  RepositoryAssessor: class {
    constructor(...options: unknown[]) { mock.assessorOptions.push(options); }
    assess = mock.assess;
    refineAssessment = mock.assess;
  },
}));
vi.mock('../src/community/collector.js', () => ({
  CommunityCollector: class { scan = mock.scan; },
}));
import { main } from '../src/cli.js';
import { defaultProjectConfig } from '../src/core/config.js';
import { projectIdFor, projectStateDir } from '../src/core/state-paths.js';
import { ObservedTokenBudget, UsageLedger } from '../src/core/usage-ledger.js';
import type { ProjectConfig } from '../src/core/types.js';

describe('direct CLI Qwen call sites wire the project usage ledger and budget', () => {
  let root: string; let state: string; let config: ProjectConfig; let closeSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    mock.clientOptions.length = 0;
    mock.clientInstances.length = 0;
    mock.plannerOptions.length = 0;
    mock.assessorOptions.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    root = mkdtempSync(path.join(os.tmpdir(), 'fern-usage-wiring-'));
    state = mkdtempSync(path.join(os.tmpdir(), 'fern-usage-wiring-state-'));
    vi.stubEnv('QWEN_HARNESS_STATE_DIR', state);
    config = defaultProjectConfig(root, 'wiring', 'owner/wiring');
    config.usage = { maxObservedTokens: 7_777 };
    config.program.enabled = false;
    mock.loadConfig.mockReturnValue(config);
    mock.coordinatorStatus.mockReturnValue({});
    closeSpy = vi.spyOn(UsageLedger.prototype, 'close');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });

  function expectGuardWired(): void {
    expect(mock.clientOptions.length).toBeGreaterThan(0);
    const options = mock.clientOptions[mock.clientOptions.length - 1] as {
      usageLedger?: UsageLedger; usageBudget?: ObservedTokenBudget;
    };
    expect(options.usageLedger).toBeInstanceOf(UsageLedger);
    expect(options.usageBudget).toBeInstanceOf(ObservedTokenBudget);
    expect((options.usageBudget as ObservedTokenBudget).maxObservedTokens).toBe(7_777);
    expect(options.usageLedger?.projectId).toBe(projectIdFor(config));
    expect(options.usageLedger?.databaseFile).toBe(path.join(projectStateDir(config), 'usage.sqlite3'));
    expect(closeSpy).toHaveBeenCalled();
  }

  it('community wires the ledger and budget into its direct Qwen client', async () => {
    mock.scan.mockResolvedValue({ checked: 0, changed: 0, created: 0, skipped: 0, failed: 0 });
    expect(await main(['community', root])).toBe(0);
    expect(mock.scan).toHaveBeenCalledTimes(1);
    expectGuardWired();
    expect(mock.storeClose).toHaveBeenCalled();
  });

  it('plan wires the ledger and budget into its direct Qwen client', async () => {
    mock.findByRequirements.mockResolvedValue(null);
    mock.plannerPlan.mockResolvedValue({});
    mock.createDraft.mockResolvedValue({ id: 'plan_x' });
    expect(await main(['plan', root, '--requirements', 'PROJECT.md', '--json'])).toBe(0);
    expect(mock.plannerPlan).toHaveBeenCalledTimes(1);
    expectGuardWired();
    const [, plannerClient] = mock.plannerOptions[0] as unknown[];
    expect(plannerClient).toBe(mock.clientInstances[mock.clientInstances.length - 1]);
    expect(mock.storeClose).toHaveBeenCalled();
  });

  it('plan-redraft wires the ledger and budget into its direct Qwen client', async () => {
    mock.plannerPlan.mockResolvedValue({});
    mock.assess.mockResolvedValue({ id: 'assessment_x' });
    mock.replaceDraft.mockResolvedValue({ id: 'plan_x' });
    expect(await main(['plan-redraft', root, '--plan', 'plan_x', '--requirements', 'PROJECT.md', '--json'])).toBe(0);
    expect(mock.assess).toHaveBeenCalledTimes(1);
    expectGuardWired();
    expect(mock.saveRepositoryAssessment).toHaveBeenCalledWith({ id: 'assessment_x' });
    expect(mock.storeClose).toHaveBeenCalled();
  });

  it('plan keeps the ledger open and closed cleanly even when no model call is needed', async () => {
    mock.findByRequirements.mockResolvedValue({ id: 'plan_existing' });
    expect(await main(['plan', root, '--requirements', 'PROJECT.md', '--json'])).toBe(0);
    expect(mock.clientOptions).toHaveLength(0);
    expect(closeSpy).toHaveBeenCalled();
    expect(mock.storeClose).toHaveBeenCalled();
  });
});
