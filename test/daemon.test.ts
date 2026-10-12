import { describe, expect, it, vi } from 'vitest';
import { abortableDelay, runDaemon } from '../src/daemon.js';
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

  it('removes the abort listener when the poll delay completes normally', async () => {
    const listeners = new Set<() => void>();
    const signal = {
      addEventListener: (_type: 'abort', listener: () => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: 'abort', listener: () => void) => {
        listeners.delete(listener);
      },
    } as unknown as AbortSignal;

    // Repeated poll iterations must not accumulate listeners on the signal.
    for (let poll = 0; poll < 5; poll += 1) {
      await abortableDelay(1, signal);
      expect(listeners.size).toBe(0);
    }

    // An abort after normal completions still resolves a pending delay early.
    const controller = new AbortController();
    const pending = abortableDelay(60_000, controller.signal);
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
  });

  it('resolves immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    // The abort event already fired, so waiting for it would block a full poll
    // interval; the delay must resolve without the timer.
    await expect(abortableDelay(60_000, controller.signal)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
