import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ intakeConfig: vi.fn(), loadConfig: vi.fn() }));
vi.mock('../src/core/config.js', async (original) => ({
  ...await original<typeof import('../src/core/config.js')>(),
  loadProjectConfig: mock.loadConfig,
}));
vi.mock('../src/intake/connection.js', () => ({ intakeConnection: mock.intakeConfig }));
vi.mock('../src/qwen/credential-resolver.js', () => ({
  resolveQwenCredential: () => ({ apiKey: 'test-key', source: 'test' }),
  assertQwenCredentialCompatibility: vi.fn(),
  qwenCredentialCompatibilityProblem: () => null,
}));
vi.mock('../src/runtime/safe-process.js', () => ({
  runProcess: async () => ({ exitCode: 127, stdout: '', stderr: 'unavailable' }),
}));
import { main } from '../src/cli.js';
import { runDoctor } from '../src/doctor.js';
import { defaultProjectConfig } from '../src/core/config.js';
import { projectIdFor, projectStateDir } from '../src/core/state-paths.js';
import { UsageLedger } from '../src/core/usage-ledger.js';
import type { ProjectConfig } from '../src/core/types.js';

const SPEC_VALUE = {
  title: 'Test product', objective: 'Deliver memory', users: ['Developers'],
  requirements: [{ id: 'R1', description: 'Memory', acceptanceCriteria: ['A stored skill can be retrieved'], basis: 'source', rationale: 'User input', evidence: [{ ref: 'idea', quote: 'Build an agent memory engine' }] }],
  assumptions: [], decisions: [], nonGoals: [], validation: ['Run retrieval end to end'], unprovenClaims: [],
};

function seedLedger(config: ProjectConfig, directUsage: number): void {
  const ledger = new UsageLedger(projectIdFor(config), projectStateDir(config));
  ledger.recordDirectApiUsage('seed-call-1', { total_tokens: directUsage });
  ledger.close();
}

describe('usage-status command', () => {
  let root: string; let state: string; let logs: string[];
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => { logs.push(values.join(' ')); });
    logs = [];
    root = mkdtempSync(path.join(os.tmpdir(), 'fern-usage-status-'));
    state = mkdtempSync(path.join(os.tmpdir(), 'fern-usage-status-state-'));
    vi.stubEnv('QWEN_HARNESS_STATE_DIR', state);
    // Read-only command: any network attempt is a defect.
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('usage-status must not use the network'); }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });

  function configWith(limit: number | null, v1 = false): ProjectConfig {
    const config = defaultProjectConfig(root, 'usage-status', 'owner/usage');
    config.usage = { maxObservedTokens: limit };
    const resolved = v1 ? ({ ...config, configVersion: 1 } as ProjectConfig) : config;
    mock.loadConfig.mockReturnValue(resolved);
    return resolved;
  }

  it('reports ledger summary, configured limit, and budget reason as JSON', async () => {
    const config = configWith(1_000);
    const ledger = new UsageLedger(projectIdFor(config), projectStateDir(config));
    ledger.recordQwenSessionSnapshot('sess-1', { total_tokens: 300 });
    ledger.recordDirectApiUsage('call-1', { total_tokens: 500 });
    ledger.close();

    expect(await main(['usage-status', root, '--json'])).toBe(0);
    const report = JSON.parse(logs.join('\n'));
    expect(report.projectId).toBe(projectIdFor(config));
    expect(report.observedTotalTokens).toBe(800);
    expect(report.qwenSessionCount).toBe(1);
    expect(report.directCallCount).toBe(1);
    expect(report.maxObservedTokens).toBe(1_000);
    expect(report.budget).toEqual({ blocked: false, reason: 'ok' });
    expect(report.note).toContain('NOT Alibaba account Credits');
  });

  it('labels the observed total as a lower bound in human output and shows a blocked budget', async () => {
    const config = configWith(100);
    seedLedger(config, 500);

    expect(await main(['usage-status', root])).toBe(0);
    const text = logs.join('\n');
    expect(text).toContain('lower bound');
    expect(text).toContain('NOT Alibaba account Credits');
    expect(text).toContain('BLOCKED (limit-reached)');
    expect(text).toContain('100');
  });

  it('ignores any usage limit on a v1 config and reports the budget as disabled', async () => {
    const config = configWith(5, true);
    seedLedger(config, 500);

    expect(await main(['usage-status', root, '--json'])).toBe(0);
    const report = JSON.parse(logs.join('\n'));
    expect(report.maxObservedTokens).toBeNull();
    expect(report.budget).toEqual({ blocked: false, reason: 'disabled' });
  });
});

describe('CLI direct Qwen call usage coverage', () => {
  let root: string; let state: string; let fetchMock: ReturnType<typeof vi.fn>;
  let closeSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    root = mkdtempSync(path.join(os.tmpdir(), 'fern-usage-cli-'));
    state = mkdtempSync(path.join(os.tmpdir(), 'fern-usage-cli-state-'));
    vi.stubEnv('QWEN_HARNESS_STATE_DIR', state);
    closeSpy = vi.spyOn(UsageLedger.prototype, 'close');
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.stubGlobal('fetch', fetch);
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });

  it('blocks the spec command on the observed-token budget before any network attempt and closes the ledger', async () => {
    const config = defaultProjectConfig(root, 'spec-budget', 'owner/spec');
    config.usage = { maxObservedTokens: 100 };
    mock.intakeConfig.mockReturnValue(config);
    seedLedger(config, 500);
    fetchMock.mockImplementation(() => { throw new Error('network must not happen when the budget blocks'); });

    await expect(main(['spec', root, '--idea', 'Build an agent memory engine'])).rejects.toThrow('Observed-token budget');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(closeSpy).toHaveBeenCalled();
  });

  it('counts a successful metered spec call in the project ledger and closes it', async () => {
    const config = defaultProjectConfig(root, 'spec-metered', 'owner/spec2');
    config.usage = { maxObservedTokens: null };
    mock.intakeConfig.mockReturnValue(config);
    fetchMock.mockImplementation(async () =>
      Response.json({ choices: [{ message: { content: JSON.stringify(SPEC_VALUE) } }], usage: { total_tokens: 10 } }),
    );

    expect(await main(['spec', root, '--idea', 'Build an agent memory engine'])).toBe(0);
    expect(fetchMock).toHaveBeenCalled();
    const ledger = new UsageLedger(projectIdFor(config), projectStateDir(config));
    try {
      expect(ledger.summary()).toMatchObject({ directCallCount: 1, observedTotalTokens: 10, unmeteredCount: 0 });
    } finally { ledger.close(); }
    expect(closeSpy).toHaveBeenCalled();
  });

  it('closes the ledger when a spec call fails mid-request', async () => {
    const config = defaultProjectConfig(root, 'spec-fail', 'owner/spec3');
    config.usage = { maxObservedTokens: null };
    mock.intakeConfig.mockReturnValue(config);
    fetchMock.mockRejectedValue(new Error('network down'));

    await expect(main(['spec', root, '--idea', 'Build an agent memory engine'])).rejects.toThrow('network down');
    expect(closeSpy).toHaveBeenCalled();
  });

  it('gates the doctor live check on the observed-token budget and closes its ledger', async () => {
    const config = defaultProjectConfig(root, 'doctor-budget', 'owner/doctor');
    config.usage = { maxObservedTokens: 100 };
    seedLedger(config, 500);
    fetchMock.mockImplementation(() => { throw new Error('network must not happen when the budget blocks'); });

    const report = await runDoctor(config, { live: true });
    const live = report.checks.find((check) => check.id === 'qwen-live');
    expect(live?.status).toBe('fail');
    expect(live?.details).toContain('Observed-token budget');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(closeSpy).toHaveBeenCalled();
  });
});
