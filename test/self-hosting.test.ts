import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultProjectConfig } from '../src/core/config.js';
import { PersistentTaskStore } from '../src/core/persistent-store.js';
import { ControllerReleaseManager } from '../src/self-hosting/releases.js';
import { makeTmp } from './helpers.js';

describe('ControllerReleaseManager', () => {
  it('evaluates an isolated successor and supports protected promotion and rollback', async () => {
    const stateRoot = makeTmp('controller-state');
    const targetId = 'festival-proof';
    const targetStore = new PersistentTaskStore(targetId, path.join(stateRoot, 'projects', targetId));
    targetStore.savePortfolioPlan({
      id: 'festival-plan', projectId: targetId, sourcePath: 'PROJECT.md', contentHash: 'objective', title: 'Festival SOS', objective: 'Deliver',
      constraints: [], definitionOfDone: ['Verified'], technologyDecisions: [], deploymentDecisions: [], status: 'maintaining',
      epicIssueNumber: null, epicIssueUrl: null, stories: [], createdAt: 1, updatedAt: 2, approvedAt: 1,
      deliveredAt: Date.now() - 10_000,
    });
    targetStore.close();

    const candidateRoot = gitCandidate();
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: candidateRoot, encoding: 'utf8' }).trim();
    const config = defaultProjectConfig(candidateRoot, 'harness', 'owner/harness');
    config.selfHosting = {
      ...config.selfHosting,
      enabled: true,
      probationMs: 1_000,
      deliveryObservationMs: 1,
      requiredProjectId: targetId,
      candidateRoot,
      evaluationCommands: [{ command: '/usr/bin/true', args: [] }],
      canaryCommands: (['node', 'python', 'go', 'rust'] as const).map((stack) => ({ stack, command: '/usr/bin/true', args: [] })),
    };
    const store = new PersistentTaskStore('harness-project', path.join(stateRoot, 'projects', 'harness-project'));
    const manager = new ControllerReleaseManager(config, store, stateRoot, { command: '/usr/bin/true', args: [] });

    const candidate = await manager.evaluate(sha);
    expect(candidate.status).toBe('ready');
    expect(candidate.evaluationHash).toMatch(/^[0-9a-f]{64}$/);
    const promoted = await manager.promote(candidate.id);
    expect(promoted.status).toBe('probation');
    expect(manager.activeManifest()?.releaseId).toBe(candidate.id);
    expect(manager.rollback(candidate.id).status).toBe('rolled_back');
    expect(manager.activeManifest()?.releaseId).toBe('installed-baseline');
    expect(await manager.observe()).toBeNull();
    await expect(manager.evaluate(sha)).rejects.toThrow(/ineligible after rolled_back/);
    store.close();
  });
});

function gitCandidate(): string {
  const root = makeTmp('controller-candidate');
  mkdirSync(path.join(root, 'bin'));
  writeFileSync(path.join(root, 'package.json'), '{"name":"candidate","version":"2.0.0"}\n');
  writeFileSync(path.join(root, 'bin', 'qwen-harness.mjs'), '#!/usr/bin/env node\nconsole.log("2.0.0");\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'candidate'], { cwd: root });
  return root;
}
