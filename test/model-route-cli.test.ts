import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ github: vi.fn() }));
vi.mock('../src/github/control-plane.js', () => ({
  OctokitControlPlane: class { constructor() { mock.github(); throw new Error('GitHub must not open during update'); } },
  resolveGitHubToken: vi.fn(),
}));
import { defaultProjectConfig, serializeProjectConfig } from '../src/core/config.js';
import { main } from '../src/cli.js';

describe('update --model route selection', () => {
  let root: string;
  let state: string;
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    root = mkdtempSync(path.join(os.tmpdir(), 'fern-model-route-'));
    state = mkdtempSync(path.join(os.tmpdir(), 'fern-model-route-state-'));
    vi.stubEnv('QWEN_HARNESS_STATE_DIR', state);
    mkdirSync(path.join(root, '.qwen-harness'), { recursive: true });
    const config = defaultProjectConfig(root, 'fixture', 'owner/fixture');
    writeFileSync(path.join(root, '.qwen-harness', 'project.yml'), serializeProjectConfig(config));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });

  it('rejects unsupported models before writing any configuration', async () => {
    await expect(main(['update', root, '--model', 'gpt-9'])).rejects.toThrow('Invalid --model: gpt-9');
    const persisted = JSON.parse(readFileSync(path.join(root, '.qwen-harness', 'project.yml'), 'utf8'));
    expect(persisted.qwen.model).toBe('qwen3.8-max');
  });

  it('switches to the exact OpenRouter Crouton route and stores it', async () => {
    expect(
      await main(['update', root, '--model', 'stealth/crouton-alpha', '--no-link-extension', '--no-service', '--skip-dependencies']),
    ).toBe(0);
    const persisted = JSON.parse(readFileSync(path.join(root, '.qwen-harness', 'project.yml'), 'utf8'));
    expect(persisted.qwen).toMatchObject({
      model: 'stealth/crouton-alpha',
      baseUrl: 'https://openrouter.ai/api/v1',
      credentialEnvKey: 'OPENROUTER_API_KEY',
      billingPlan: 'custom',
    });
  });

  it('accepts the default model explicitly and preserves it when --model is omitted', async () => {
    expect(
      await main(['update', root, '--model', 'qwen3.8-max', '--no-link-extension', '--no-service', '--skip-dependencies']),
    ).toBe(0);
    expect(
      await main(['update', root, '--no-link-extension', '--no-service', '--skip-dependencies']),
    ).toBe(0);
    const persisted = JSON.parse(readFileSync(path.join(root, '.qwen-harness', 'project.yml'), 'utf8'));
    expect(persisted.qwen.model).toBe('qwen3.8-max');
  });
});
