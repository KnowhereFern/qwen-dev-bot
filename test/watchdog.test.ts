import { describe, expect, it } from 'vitest';
import { IssueStore } from '../src/store.js';
import { Watchdog } from '../src/watchdog.js';
import { silentLogger } from './helpers.js';

function setup(maxAttempts = 3): { store: IssueStore; watchdog: Watchdog } {
  const store = new IssueStore({ maxAttempts });
  return { store, watchdog: new Watchdog(store, silentLogger) };
}

describe('watchdog', () => {
  it('requeues an expired leased issue to ready, incrementing attempts', () => {
    const { store, watchdog } = setup();
    const issue = store.add({ title: 'stalled claim' });
    store.transition(issue.id, 'leased', { leaseExpiresAt: 1000 }, 900);

    const recovered = watchdog.runOnce(1001);

    expect(recovered).toHaveLength(1);
    const after = store.get(issue.id);
    expect(after.state).toBe('ready');
    expect(after.attempts).toBe(1);
    expect(after.leaseExpiresAt).toBeNull();
    expect(after.lastError).toContain('lease expired');
  });

  it('requeues an expired active issue to ready, incrementing attempts', () => {
    const { store, watchdog } = setup();
    const issue = store.add({ title: 'hung executor' });
    store.transition(issue.id, 'leased', { leaseExpiresAt: 1000 }, 900);
    store.transition(issue.id, 'active', { leaseExpiresAt: 2000 }, 950);

    const recovered = watchdog.runOnce(2001);

    expect(recovered).toHaveLength(1);
    const after = store.get(issue.id);
    expect(after.state).toBe('ready');
    expect(after.attempts).toBe(1);
  });

  it('leaves issues with unexpired leases alone', () => {
    const { store, watchdog } = setup();
    const leased = store.add({ title: 'fresh lease' });
    store.transition(leased.id, 'leased', { leaseExpiresAt: 5000 }, 1000);
    const active = store.add({ title: 'fresh active' });
    store.transition(active.id, 'leased', { leaseExpiresAt: 5000 }, 1000);
    store.transition(active.id, 'active', { leaseExpiresAt: 9000 }, 1001);

    expect(watchdog.runOnce(4000)).toHaveLength(0);
    expect(store.get(leased.id).state).toBe('leased');
    expect(store.get(leased.id).attempts).toBe(0);
    expect(store.get(active.id).state).toBe('active');
    expect(store.get(active.id).attempts).toBe(0);
  });

  it('marks an expired active issue failed once max attempts are exhausted', () => {
    const { store, watchdog } = setup(2);
    const issue = store.add({ title: 'keeps timing out' });

    // Attempt 1 burns -> ready; attempt 2 expires -> failed.
    store.transition(issue.id, 'leased', { leaseExpiresAt: 100 }, 50);
    store.transition(issue.id, 'active', { leaseExpiresAt: 200 }, 60);
    watchdog.runOnce(201);
    expect(store.get(issue.id).state).toBe('ready');
    expect(store.get(issue.id).attempts).toBe(1);

    store.claimNext(300, 100);
    store.transition(issue.id, 'active', { leaseExpiresAt: 400 }, 310);
    const recovered = watchdog.runOnce(401);

    expect(recovered).toHaveLength(1);
    const after = store.get(issue.id);
    expect(after.state).toBe('failed');
    expect(after.attempts).toBe(2);
  });

  it('marks an expired leased issue failed once max attempts are exhausted', () => {
    const { store, watchdog } = setup(1);
    const issue = store.add({ title: 'never starts' });
    store.transition(issue.id, 'leased', { leaseExpiresAt: 100 }, 50);

    const recovered = watchdog.runOnce(101);

    expect(recovered).toHaveLength(1);
    const after = store.get(issue.id);
    expect(after.state).toBe('failed');
    expect(after.attempts).toBe(1);
  });

  it('ignores issues in states without leases', () => {
    const { store, watchdog } = setup();
    store.add({ title: 'plain ready' });
    const done = store.add({ title: 'done one' });
    store.transition(done.id, 'leased', { leaseExpiresAt: 100 });
    store.transition(done.id, 'active', {});
    store.transition(done.id, 'done', { leaseExpiresAt: null });

    expect(watchdog.runOnce(10_000)).toHaveLength(0);
    expect(store.counts()).toEqual({ ready: 1, leased: 0, active: 0, done: 1, failed: 0 });
  });
});
