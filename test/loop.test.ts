import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockAgentExecutor } from '../src/agent/mock.js';
import { createMockScripts, createWorkspace } from '../src/demo/workspace.js';
import { Dispatcher } from '../src/dispatcher.js';
import { MockGitHubAdapter } from '../src/github/mock.js';
import { OrchestratorLoop } from '../src/loop.js';
import { Monitor } from '../src/monitor.js';
import { IssueStore } from '../src/store.js';
import { TestGate } from '../src/test-gate.js';
import { Watchdog } from '../src/watchdog.js';
import { makeTmp, silentLogger } from './helpers.js';

describe('orchestrator loop (integration, mock mode)', () => {
  it(
    'runs the full self-repair loop end to end and drains to all-done',
    { timeout: 30_000 },
    async () => {
      const workDir = makeTmp('loop-e2e');
      createWorkspace(workDir);

      const adapter = new MockGitHubAdapter();
      const store = new IssueStore({ maxAttempts: 3 });
      const seed = await adapter.createIssue({
        title: 'Add greeting feature',
        body: 'Seed issue.',
        labels: ['feature'],
      });
      store.add({ title: seed.title, body: seed.body, labels: seed.labels, issueNumber: seed.number });

      const monitor = new Monitor(adapter, store, new TestGate(process.execPath, ['postmerge.mjs'], workDir, 15_000), silentLogger);
      const dispatcher = new Dispatcher(
        store,
        adapter,
        new MockAgentExecutor(createMockScripts()),
        new TestGate(process.execPath, ['check.mjs'], workDir, 15_000),
        {
          maxConcurrent: 2,
          leaseMs: 5_000,
          executionTimeoutMs: 30_000,
          workDir,
          baseBranch: 'main',
          onMerged: (merge) => monitor.enqueue(merge),
        },
        silentLogger,
      );
      const loop = new OrchestratorLoop(
        dispatcher,
        new Watchdog(store, silentLogger),
        monitor,
        store,
        { tickMs: 5, maxTicks: 2000, stopWhenDrained: true },
        silentLogger,
      );

      const outcome = await loop.start();

      expect(outcome).toBe('drained');
      expect(store.counts()).toEqual({ ready: 0, leased: 0, active: 0, done: 2, failed: 0 });

      const repair = store.all().find((issue) => issue.labels.includes('self-repair'));
      expect(repair).toBeDefined();
      expect(repair?.state).toBe('done');
      expect(repair?.title).toContain('PR #1');

      // First merge failed post-merge checks (seeded regression), the repair
      // merge passed. Exactly two PRs, both merged.
      expect(monitor.results.map((result) => result.ok)).toEqual([false, true]);
      const prs = [...adapter.pullRequests.values()];
      expect(prs).toHaveLength(2);
      expect(prs.every((pr) => pr.merged)).toBe(true);

      // The repair actually removed the seeded regression marker.
      expect(existsSync(path.join(workDir, '.known-bug'))).toBe(false);
      expect(existsSync(path.join(workDir, 'features', 'add-greeting-feature.mjs'))).toBe(true);
    },
  );
});
