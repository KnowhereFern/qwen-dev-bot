import { describe, expect, it } from 'vitest';
import { PersistentTaskStore, failureFingerprint } from '../src/core/persistent-store.js';
import type { TaskSpec } from '../src/core/types.js';
import { makeTmp } from './helpers.js';

function taskSpec(dependencies: number[]): TaskSpec {
  return {
    goal: 'Implement the task',
    source: { kind: 'user', author: 'owner' },
    acceptanceCriteria: ['The task is complete.'],
    constraints: [],
    requiredGateIds: [],
    rewardCriterionIds: [],
    risk: 'low',
    dependencies,
    rollback: 'Revert the task commit.',
    technologyDecisions: [],
    deploymentDecisions: [],
  };
}

describe('PersistentTaskStore', () => {
  it('persists and deduplicates portfolio plans by requirements hash', () => {
    const stateDir = makeTmp('persistent-portfolio');
    let store = new PersistentTaskStore('portfolio-project', stateDir);
    const plan = {
      id: 'plan_123', projectId: 'portfolio-project', sourcePath: 'REQUIREMENTS.md', contentHash: 'abc',
      title: 'Plan', objective: 'Ship', constraints: [], definitionOfDone: ['Done'], status: 'draft' as const,
      technologyDecisions: [], deploymentDecisions: [],
      epicIssueNumber: null, epicIssueUrl: null, stories: [], createdAt: 1, updatedAt: 1, approvedAt: null,
    };
    store.savePortfolioPlan(plan);
    store.close();

    store = new PersistentTaskStore('portfolio-project', stateDir);
    expect(store.findPortfolioPlanByHash('abc')).toEqual(plan);
    expect(store.listPortfolioPlans()).toEqual([plan]);
    store.close();
  });

  it('persists tasks, leases, checkpoints, and idempotency across restarts', () => {
    const stateDir = makeTmp('persistent-store');
    let store = new PersistentTaskStore('project-a', stateDir);
    const task = store.upsert({ issueNumber: 7, title: 'durable task', state: 'normalized', maxAttempts: 5 });
    store.transition(task.id, 'ready');
    const claimed = store.claimNext('worker-1', 10_000, 1_000);
    expect(claimed?.state).toBe('leased');
    expect(claimed?.leaseOwner).toBe('worker-1');
    store.heartbeat(task.id, 'worker-1', 10_000, 2_000);
    store.saveCheckpoint({
      taskId: task.id,
      phase: 'leased',
      qwenSessionId: 'session-1',
      qwenWorkflowRunId: null,
      baseSha: 'abc',
      commitSha: null,
      payload: { phase: 'claimed' },
      createdAt: 2_100,
    });
    store.recordEvent('external.once', task.id, { ok: true }, 'once-key');
    store.close();

    store = new PersistentTaskStore('project-a', stateDir);
    expect(store.get(task.id).leaseExpiresAt).toBe(12_000);
    expect(store.latestCheckpoint(task.id)?.qwenSessionId).toBe('session-1');
    expect(store.hasIdempotencyKey('once-key')).toBe(true);
    expect(store.recordEvent('external.once', task.id, { ok: false }, 'once-key').payload).toEqual({ ok: true });
    store.close();
  });

  it('quarantines the third identical failure while allowing distinct repair attempts', () => {
    const store = new PersistentTaskStore('project-b', makeTmp('persistent-failure'));
    const task = store.upsert({ issueNumber: 1, title: 'flaky', state: 'normalized', maxAttempts: 5 });
    store.transition(task.id, 'ready');

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      store.claimNext('worker', 100, attempt * 1_000);
      store.transition(task.id, 'active');
      const failed = store.recordFailure(task.id, `test failed at /tmp/run-${attempt}/file.ts line ${attempt}`, 3);
      expect(failed.state).toBe('ready');
      expect(failed.identicalFailures).toBe(attempt);
    }
    store.claimNext('worker', 100, 3_000);
    store.transition(task.id, 'active');
    const quarantined = store.recordFailure(task.id, 'test failed at /tmp/run-3/file.ts line 3', 3);
    expect(quarantined.state).toBe('quarantined');
    expect(quarantined.attempts).toBe(3);
    store.close();
  });

  it('carries identical failure history into a replacement task', () => {
    const store = new PersistentTaskStore('project-lineage', makeTmp('persistent-lineage'));
    const original = store.upsert({ issueNumber: 1, title: 'original', state: 'ready', maxAttempts: 5 });
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      store.claimNext('worker', 100, attempt * 1_000);
      store.transition(original.id, 'active');
      store.recordFailure(original.id, `compiler failed at /tmp/run-${attempt}/main.ts line ${attempt}`, 3);
    }
    const lineage = store.get(original.id);
    store.transition(original.id, 'cancelled');
    const replacement = store.upsert({
      issueNumber: 2,
      title: 'replacement',
      state: 'ready',
      maxAttempts: 5,
      failureLineageId: lineage.failureLineageId,
      lineageFailures: lineage.lineageFailures,
      identicalFailures: lineage.identicalFailures,
      lastFailureFingerprint: lineage.lastFailureFingerprint,
    });
    store.claimNext('worker', 100, 3_000);
    store.transition(replacement.id, 'active');

    const quarantined = store.recordFailure(replacement.id, 'compiler failed at /tmp/run-3/main.ts line 3', 3);
    expect(quarantined.state).toBe('quarantined');
    expect(quarantined.failureLineageId).toBe(original.id);
    expect(quarantined.lineageFailures).toBe(3);
    store.close();
  });

  it('skips blocked ready tasks and claims them only after every dependency is done', () => {
    const blockedStore = new PersistentTaskStore('project-dependencies-blocked', makeTmp('dependencies-blocked'));
    blockedStore.upsert({ issueNumber: 1, title: 'dependency in progress', state: 'active', spec: taskSpec([]) });
    blockedStore.upsert({ issueNumber: 2, title: 'blocked high priority', state: 'ready', priority: 0, spec: taskSpec([1]) });
    blockedStore.upsert({ issueNumber: 3, title: 'independent lower priority', state: 'ready', priority: 1, spec: taskSpec([]) });

    expect(blockedStore.claimNext('worker', 1_000, 100)?.issueNumber).toBe(3);
    blockedStore.close();

    const readyStore = new PersistentTaskStore('project-dependencies-done', makeTmp('dependencies-done'));
    readyStore.upsert({ issueNumber: 1, title: 'completed dependency', state: 'done', spec: taskSpec([]) });
    readyStore.upsert({ issueNumber: 2, title: 'now unblocked', state: 'ready', spec: taskSpec([1]) });

    expect(readyStore.claimNext('worker', 1_000, 100)?.issueNumber).toBe(2);
    readyStore.close();
  });

  it('resolves dependencies that name the original source issue', () => {
    const store = new PersistentTaskStore('project-source-dependency', makeTmp('source-dependency'));
    const completed = taskSpec([]);
    completed.source.url = 'https://github.com/owner/repo/issues/10';
    store.upsert({ issueNumber: 101, title: 'normalized dependency', state: 'done', spec: completed });
    store.upsert({ issueNumber: 102, title: 'dependent task', state: 'ready', spec: taskSpec([10]) });

    expect(store.claimNext('worker', 1_000, 100)?.issueNumber).toBe(102);
    store.close();
  });

  it('allows post-merge reconciliation after a PR is merged before CI polling completes', () => {
    for (const state of ['pr_open', 'waiting_ci'] as const) {
      const store = new PersistentTaskStore(`project-external-merge-${state}`, makeTmp(`external-merge-${state}`));
      const task = store.upsert({ issueNumber: 20, title: 'externally merged task', state, spec: taskSpec([]) });
      expect(store.transition(task.id, 'post_merge').state).toBe('post_merge');
      store.close();
    }
  });

  it('freezes the normalized task contract after a worker claims it', () => {
    const store = new PersistentTaskStore('project-spec-freeze', makeTmp('spec-freeze'));
    const original = taskSpec([]);
    original.goal = 'Original accepted goal';
    const task = store.upsert({ issueNumber: 30, title: 'immutable contract', state: 'ready', spec: original });
    store.claimNext('worker', 1_000, 100);

    const edited = taskSpec([]);
    edited.goal = 'Edited after execution started';
    const updated = store.upsert({ issueNumber: 30, title: 'edited title', spec: edited }, 200);

    expect(updated.title).toBe('edited title');
    expect(updated.spec?.goal).toBe('Original accepted goal');
    expect(store.get(task.id).spec?.goal).toBe('Original accepted goal');
    store.close();
  });

  it('atomically leases reconciliation work to one worker at a time', () => {
    const stateDir = makeTmp('reconciliation-lease');
    const firstStore = new PersistentTaskStore('project-reconciliation-lease', stateDir);
    const secondStore = new PersistentTaskStore('project-reconciliation-lease', stateDir);
    firstStore.upsert({ issueNumber: 31, title: 'waiting for CI', state: 'waiting_ci', spec: taskSpec([]) });

    const claimed = firstStore.claimReconciliation('worker-1', 1_000, ['waiting_ci'], 100);
    expect(claimed?.leaseOwner).toBe('worker-1');
    expect(secondStore.claimReconciliation('worker-2', 1_000, ['waiting_ci'], 100)).toBeNull();

    firstStore.patch(claimed?.id as string, { leaseOwner: null, leaseExpiresAt: null }, 200);
    expect(secondStore.claimReconciliation('worker-2', 1_000, ['waiting_ci'], 200)?.leaseOwner).toBe('worker-2');
    firstStore.close();
    secondStore.close();
  });

  it('normalizes volatile paths, numbers, and SHAs in failure fingerprints', () => {
    expect(failureFingerprint('Failed /tmp/a/file.ts line 12 deadbeef')).toBe(
      failureFingerprint('Failed /tmp/b/file.ts line 99 cafebabe'),
    );
  });

  it('retries post-merge verification in place instead of re-running implementation', () => {
    const store = new PersistentTaskStore('project-c', makeTmp('postmerge-failure'));
    const task = store.upsert({ issueNumber: 9, title: 'merged task', state: 'normalized', maxAttempts: 5 });
    for (const state of ['ready', 'leased', 'active', 'verifying', 'pr_open', 'waiting_ci', 'merge_ready', 'post_merge'] as const) {
      store.transition(task.id, state);
    }
    expect(store.recordPostMergeFailure(task.id, 'detached verification failed at /tmp/run-1', 3).state).toBe('post_merge');
    expect(store.recordPostMergeFailure(task.id, 'detached verification failed at /tmp/run-2', 3).state).toBe('post_merge');
    expect(store.recordPostMergeFailure(task.id, 'detached verification failed at /tmp/run-3', 3).state).toBe('quarantined');
    store.close();
  });
});
