import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ complete: vi.fn(), config: vi.fn(), github: vi.fn(), store: vi.fn() }));
vi.mock('../src/intake/connection.js', () => ({ intakeConnection: mock.config }));
vi.mock('../src/qwen/credential-resolver.js', () => ({
  resolveQwenCredential: () => null, assertQwenCredentialCompatibility: vi.fn(), qwenCredentialCompatibilityProblem: () => null,
}));
vi.mock('../src/qwen/qwen-api.js', () => ({ QwenApiClient: class { completeJson = mock.complete; } }));
vi.mock('../src/github/control-plane.js', () => ({ OctokitControlPlane: class { constructor() { mock.github(); throw new Error('GitHub must not open during intake'); } }, resolveGitHubToken: vi.fn() }));
vi.mock('../src/core/persistent-store.js', () => ({ PersistentTaskStore: class { constructor() { mock.store(); throw new Error('Task store must not open during intake'); } } }));
import { main } from '../src/cli.js';
import { listSpecifications } from '../src/intake/specification.js';

describe('pre-setup specification CLI', () => {
  let root: string; let state: string;
  beforeEach(() => {
    vi.clearAllMocks(); vi.spyOn(console, 'log').mockImplementation(() => {});
    root = mkdtempSync(path.join(os.tmpdir(), 'fern-spec-cli-project-'));
    state = mkdtempSync(path.join(os.tmpdir(), 'fern-spec-cli-state-'));
    vi.stubEnv('QWEN_HARNESS_STATE_DIR', state);
    mock.config.mockReturnValue({ qwen: { model: 'qwen3.8-max', baseUrl: 'https://example.com/v1' } });
    mock.complete.mockResolvedValue({ value: {
      title: 'Test product', objective: 'Deliver memory', users: ['Developers'], requirements: [{ id: 'R1', description: 'Memory', acceptanceCriteria: ['A stored skill can be retrieved'], basis: 'source', rationale: 'User input', evidence: [{ ref: 'idea', quote: 'Build an agent memory engine' }] }], assumptions: [], decisions: [], nonGoals: [], validation: ['Run retrieval end to end'], unprovenClaims: [],
    } });
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); });
  it('drafts and reads before Git/setup with no task store or GitHub side effects', async () => {
    expect(await main(['spec', '--idea', 'Build an agent memory engine', root, '--json'])).toBe(0);
    const [draft] = listSpecifications(root);
    expect(draft.status).toBe('draft');
    expect(readdirSync(root)).toEqual([]);
    expect(mock.config).toHaveBeenCalledWith(root);
    expect(mock.github).not.toHaveBeenCalled(); expect(mock.store).not.toHaveBeenCalled();
    expect(await main(['spec-status', root, '--spec', draft.id, '--json'])).toBe(0);
    expect(mock.complete).toHaveBeenCalledTimes(1);
  });
  it('rejects approval flags before invoking a model or accessing credentials', async () => {
    await expect(main(['spec', root, '--idea', 'Build an agent memory engine', '--approve'])).rejects.toThrow('cannot approve');
    expect(mock.config).not.toHaveBeenCalled(); expect(mock.complete).not.toHaveBeenCalled();
  });
  it('rejects missing flag values without a model request', async () => {
    await expect(main(['spec', root, '--input', '--json'])).rejects.toThrow('--input');
    expect(mock.config).not.toHaveBeenCalled(); expect(mock.complete).not.toHaveBeenCalled();
  });
});
