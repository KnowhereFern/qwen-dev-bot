import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockAgentExecutor } from '../src/agent/mock.js';
import { Dispatcher, type MergeRecord } from '../src/dispatcher.js';
import { MockGitHubAdapter } from '../src/github/mock.js';
import { Monitor } from '../src/monitor.js';
import { IssueStore } from '../src/store.js';
import { TestGate } from '../src/test-gate.js';
import { makeTmp, silentLogger } from './helpers.js';

const MERGE: MergeRecord = {
  issueId: 'iss_1',
  issueNumber: 5,
  title: 'Add thing',
  branch: 'bot/issue-5-attempt-1',
  prNumber: 7,
  mergedAt: 1_700_000_000_000,
};

describe('monitor / self-repair', () => {
  it('creates a labeled, linked self-repair issue when a post-merge check fails', async () => {
    const workDir = makeTmp('monitor-fail');
    writeFileSync(path.join(workDir, 'fail.mjs'), 'process.exit(1)\n', 'utf8');
    const adapter = new MockGitHubAdapter();
    const store = new IssueStore();
    const monitor = new Monitor(adapter, store, new TestGate(process.execPath, ['fail.mjs'], workDir, 10_000), silentLogger);

    monitor.enqueue(MERGE);
    const results = await monitor.runOnce();

    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);

    expect(adapter.issues.size).toBe(1);
    const created = [...adapter.issues.values()][0];
    expect(created?.labels).toContain('self-repair');
    expect(created?.title).toContain('PR #7');
    expect(created?.body).toContain('PR #7');
    expect(created?.body).toContain('bot/issue-5-attempt-1');
    expect(created?.body).toContain('#5');

    const record = store.all().find((issue) => issue.issueNumber === created?.number);
    expect(record).toBeDefined();
    expect(record?.state).toBe('ready');
    expect(record?.labels).toContain('self-repair');
    expect(results[0]?.repairIssueId).toBe(record?.id);
    expect(monitor.pending).toBe(0);
  });

  it('opens nothing when post-merge checks pass', async () => {
    const workDir = makeTmp('monitor-pass');
    const adapter = new MockGitHubAdapter();
    const store = new IssueStore();
    const monitor = new Monitor(
      adapter,
      store,
      new TestGate(process.execPath, ['-e', 'process.exit(0)'], workDir, 10_000),
      silentLogger,
    );

    monitor.enqueue(MERGE);
    const results = await monitor.runOnce();

    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(true);
    expect(adapter.issues.size).toBe(0);
    expect(store.all()).toHaveLength(0);
    expect(monitor.pending).toBe(0);
  });

  it('self-repair issue re-enters the loop and is resolved by the dispatcher', async () => {
    const workDir = makeTmp('monitor-reenter');
    writeFileSync(path.join(workDir, 'fail.mjs'), 'process.exit(1)\n', 'utf8');
    const adapter = new MockGitHubAdapter();
    const store = new IssueStore({ maxAttempts: 3 });
    const monitor = new Monitor(adapter, store, new TestGate(process.execPath, ['fail.mjs'], workDir, 10_000), silentLogger);

    monitor.enqueue(MERGE);
    await monitor.runOnce();
    expect(store.listByState('ready')).toHaveLength(1);

    // The same dispatcher machinery picks the repair issue up like any other.
    const dispatcher = new Dispatcher(
      store,
      adapter,
      new MockAgentExecutor(),
      new TestGate(process.execPath, ['-e', 'process.exit(0)'], workDir, 10_000),
      {
        maxConcurrent: 1,
        leaseMs: 60_000,
        executionTimeoutMs: 60_000,
        workDir,
        baseBranch: 'main',
      },
      silentLogger,
    );

    expect(dispatcher.poll()).toBe(1);
    const repair = store.all()[0];
    expect(repair?.labels).toContain('self-repair');
    // Claiming activates the issue synchronously (leased -> active happens in
    // the same poll call, before the pipeline's first await).
    expect(repair?.state).toBe('active');

    await dispatcher.drain();
    expect(store.get((repair as { id: string }).id).state).toBe('done');
  });
});
