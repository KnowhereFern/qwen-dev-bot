import { describe, expect, it, vi } from 'vitest';
import { runDaemon } from '../src/daemon.js';
import { ProjectRegistry } from '../src/registry.js';
import { makeTmp, silentLogger } from './helpers.js';

const state = vi.hoisted(() => ({
  tickCalls: [] as string[],
  registry: null as ProjectRegistry | null,
}));

vi.mock('../src/core/config.js', () => ({
  loadProjectConfig: (configPath: string) => ({
    project: { root: configPath },
    worker: { pollIntervalMs: 30_000 },
    selfHosting: { enabled: false },
  }),
}));

vi.mock('../src/factory.js', () => ({
  createProductionHarness: async (config: { project: { root: string } }) => ({
    supervisor: {
      tick: async () => {
        state.tickCalls.push(config.project.root);
        if (config.project.root === 'project-a') state.registry?.unregister('project-b');
        return {};
      },
    },
    program: { tick: async () => ({}) },
    close: () => {},
  }),
}));

describe('runDaemon', () => {
  it('does not run a project unregistered while an earlier project is active', async () => {
    const registry = new ProjectRegistry(`${makeTmp('daemon')}/state`);
    state.registry = registry;
    state.tickCalls.length = 0;
    try {
      for (const id of ['project-a', 'project-b', 'project-c']) {
        registry.register({ id, root: `/tmp/daemon-test-${id}`, configPath: id, enabled: true });
      }

      await runDaemon({ once: true, registry, logger: silentLogger });

      expect(state.tickCalls).toEqual(['project-a', 'project-c']);
      expect(registry.list().map((project) => project.id)).toEqual(['project-a', 'project-c']);
    } finally {
      state.registry = null;
    }
  });
});
