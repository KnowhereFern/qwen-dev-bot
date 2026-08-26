import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentExecutor, AgentResult, AgentTask } from '../src/agent/executor.js';
import { MockAgentExecutor, slugify } from '../src/agent/mock.js';
import { Dispatcher, type DispatcherOptions, type MergeRecord } from '../src/dispatcher.js';
import { MockGitHubAdapter } from '../src/github/mock.js';
import { isTerminal } from '../src/state-machine.js';
import { IssueStore } from '../src/store.js';
import { TestGate } from '../src/test-gate.js';
import { makeTmp, silentLogger } from './helpers.js';

const PASSING_GATE = [process.execPath, ['-e', 'process.exit(0)']] as const;

function makeDispatcher(
  store: IssueStore,
  adapter: MockGitHubAdapter,
  executor: AgentExecutor,
  workDir: string,
  opts: Partial<DispatcherOptions> = {},
  merged?: MergeRecord[],
): Dispatcher {
  return new Dispatcher(store, adapter, executor, new TestGate(PASSING_GATE[0], [...PASSING_GATE[1]], workDir, 10_000), {
    maxConcurrent: 1,
    leaseMs: 60_000,
    executionTimeoutMs: 60_000,
    workDir,
    baseBranch: 'main',
    ...(merged ? { onMerged: (m) => merged.push(m) } : {}),
    ...opts,
  }, silentLogger);
}

describe('dispatcher', () => {
  it('claims ready issues in priority order and drives them to done + merged PRs', async () => {
    const workDir = makeTmp('dispatcher-order');
    const adapter = new MockGitHubAdapter();
    const store = new IssueStore();
    const started: string[] = [];
    const merged: MergeRecord[] = [];

    const executor = new MockAgentExecutor({}, async (task: AgentTask) => {
      started.push(task.issue.title);
      return [{ op: 'write', path: `out/${slugify(task.issue.title)}.txt`, content: 'ok' }];
    });

    store.add({ title: 'low', priority: 5 });
    store.add({ title: 'high', priority: 1 });
    store.add({ title: 'mid', priority: 3 });

    const dispatcher = makeDispatcher(store, adapter, executor, workDir, { maxConcurrent: 1 }, merged);
    for (let i = 0; i < 10 && !store.all().every((issue) => isTerminal(issue.state)); i += 1) {
      dispatcher.poll();
      await dispatcher.drain();
    }

    expect(started).toEqual(['high', 'mid', 'low']);
    expect(store.counts()).toEqual({ ready: 0, leased: 0, active: 0, done: 3, failed: 0 });
    expect(merged).toHaveLength(3);
    expect([...adapter.pullRequests.values()]).toHaveLength(3);
    expect([...adapter.pullRequests.values()].every((pr) => pr.merged)).toBe(true);
    expect(store.all().map((issue) => issue.prNumber).sort()).toEqual([1, 2, 3]);
  });

  it('respects the max-concurrent-agents limit', async () => {
    const workDir = makeTmp('dispatcher-concurrency');
    const adapter = new MockGitHubAdapter();
    const store = new IssueStore();

    class BlockingExecutor implements AgentExecutor {
      readonly name = 'blocking';
      readonly started: string[] = [];
      private readonly waiters: Array<() => void> = [];

      execute(task: AgentTask): Promise<AgentResult> {
        this.started.push(task.issue.id);
        return new Promise((resolve) => {
          this.waiters.push(() => resolve({ summary: 'ok', changedFiles: [] }));
        });
      }

      releaseOne(): void {
        this.waiters.shift()?.();
      }

      releaseAll(): void {
        while (this.waiters.length > 0) this.releaseOne();
      }
    }

    const executor = new BlockingExecutor();
    for (let i = 0; i < 4; i += 1) store.add({ title: `issue ${i}` });
    const dispatcher = makeDispatcher(store, adapter, executor, workDir, { maxConcurrent: 2 });

    expect(dispatcher.poll()).toBe(2);
    expect(dispatcher.inflight).toBe(2);
    // Both claimed issues activate synchronously; the executor starts once the
    // async pipeline reaches it (after branch creation).
    expect(store.listByState('active')).toHaveLength(2);
    await vi.waitFor(() => expect(executor.started).toHaveLength(2));

    // Limit reached: polling again must not claim more work.
    expect(dispatcher.poll()).toBe(0);
    expect(store.listByState('ready')).toHaveLength(2);

    // Free one slot: the next issue is claimed.
    executor.releaseOne();
    await vi.waitFor(() => expect(dispatcher.inflight).toBe(1));
    expect(dispatcher.poll()).toBe(1);
    expect(dispatcher.inflight).toBe(2);
    await vi.waitFor(() => expect(executor.started).toHaveLength(3));

    executor.releaseAll();
    await dispatcher.drain();

    // Drain settles in-flight work; a final poll picks up the last issue.
    expect(dispatcher.poll()).toBe(1);
    await vi.waitFor(() => expect(executor.started).toHaveLength(4));
    executor.releaseAll();
    await dispatcher.drain();
    expect(store.counts()).toEqual({ ready: 0, leased: 0, active: 0, done: 4, failed: 0 });
  });

  it('requeues through the test gate: failing attempt -> ready, retry -> done', async () => {
    const workDir = makeTmp('dispatcher-retry');
    writeFileSync(
      path.join(workDir, 'gatecheck.mjs'),
      "import { existsSync } from 'node:fs';\nprocess.exit(existsSync('fail-marker') ? 1 : 0);\n",
      'utf8',
    );
    const adapter = new MockGitHubAdapter();
    const store = new IssueStore({ maxAttempts: 3 });
    const issue = store.add({ title: 'flaky feature', labels: ['feature'] });

    // Attempt 1 leaves a marker that fails the gate; attempt 2 removes it.
    const executor = new MockAgentExecutor({}, (task) =>
      task.issue.attempts === 0
        ? [{ op: 'write', path: 'fail-marker', content: 'x' }]
        : [{ op: 'delete', path: 'fail-marker' }],
    );

    const dispatcher = new Dispatcher(
      store,
      adapter,
      executor,
      new TestGate(process.execPath, ['gatecheck.mjs'], workDir, 10_000),
      {
        maxConcurrent: 1,
        leaseMs: 60_000,
        executionTimeoutMs: 60_000,
        workDir,
        baseBranch: 'main',
      },
      silentLogger,
    );

    dispatcher.poll();
    await dispatcher.drain();
    expect(store.get(issue.id).state).toBe('ready');
    expect(store.get(issue.id).attempts).toBe(1);
    expect(store.get(issue.id).lastError).toContain('test gate failed');

    dispatcher.poll();
    await dispatcher.drain();
    expect(store.get(issue.id).state).toBe('done');
    expect(store.get(issue.id).attempts).toBe(1);
    expect(store.get(issue.id).prNumber).toBe(1);
    expect(adapter.pullRequests.get(1)?.merged).toBe(true);
  });

  it('executor error counts as an attempt and eventually fails the issue', async () => {
    const workDir = makeTmp('dispatcher-error');
    const adapter = new MockGitHubAdapter();
    const store = new IssueStore({ maxAttempts: 2 });
    const issue = store.add({ title: 'broken' });

    const executor: AgentExecutor = {
      name: 'always-throws',
      execute: () => Promise.reject(new Error('boom')),
    };
    const dispatcher = makeDispatcher(store, adapter, executor, workDir, { maxConcurrent: 1 });

    dispatcher.poll();
    await dispatcher.drain();
    expect(store.get(issue.id).state).toBe('ready');
    expect(store.get(issue.id).attempts).toBe(1);

    dispatcher.poll();
    await dispatcher.drain();
    expect(store.get(issue.id).state).toBe('failed');
    expect(store.get(issue.id).attempts).toBe(2);
    expect(store.get(issue.id).lastError).toBe('boom');
    expect(adapter.pullRequests.size).toBe(0);
  });
});
