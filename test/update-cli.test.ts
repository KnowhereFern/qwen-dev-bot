import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ config: vi.fn(), install: vi.fn() }));
vi.mock('../src/core/config.js', async (original) => ({
  ...await original<typeof import('../src/core/config.js')>(),
  loadProjectConfig: mock.config,
}));
vi.mock('../src/installer/installer.js', () => ({ installProject: mock.install, uninstallProject: vi.fn() }));
import { main } from '../src/cli.js';

describe('update command argument forwarding', () => {
  let root: string;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    root = mkdtempSync(path.join(os.tmpdir(), 'fern-update-cli-'));
    const config = {
      project: { name: 'fixture', root, githubRepo: 'owner/fixture' },
      intake: { trustedAuthors: ['github-actions[bot]', 'owner'], communityEnabled: false },
      qwen: { baseUrl: 'https://qwen.example.test/compatible-mode/v1', credentialEnvKey: 'DASHSCOPE_API_KEY', billingPlan: 'standard' },
      worker: { autoMerge: false },
      program: { enabled: true },
    };
    mock.config.mockImplementation((dir: string) => {
      if (dir !== root) throw new Error(`no project config at ${dir}`);
      return config;
    });
    mock.install.mockResolvedValue({ config, receipt: {}, summary: ['fixture update summary'] });
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

  it('forwards --dry-run to installProject without executing the installer', async () => {
    expect(await main(['update', root, '--dry-run'])).toBe(0);
    expect(mock.install).toHaveBeenCalledOnce();
    expect(mock.install).toHaveBeenCalledWith(expect.objectContaining({ root: path.resolve(root), dryRun: true, yes: true }));
  });

  it('runs an ordinary update with dryRun: false', async () => {
    expect(await main(['update', root])).toBe(0);
    expect(mock.install).toHaveBeenCalledOnce();
    expect(mock.install).toHaveBeenCalledWith(expect.objectContaining({
      root: path.resolve(root), dryRun: false, yes: true, answers: expect.objectContaining({ projectName: 'fixture' }),
    }));
  });
});
