import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  InvalidTransitionError,
  isTerminal,
  ISSUE_STATES,
  LEGAL_TRANSITIONS,
} from '../src/state-machine.js';
import { IssueStore } from '../src/store.js';

describe('state machine', () => {
  it('allows exactly the documented legal transitions and rejects everything else', () => {
    expect([...LEGAL_TRANSITIONS.ready]).toEqual(['leased']);
    expect([...LEGAL_TRANSITIONS.leased].sort()).toEqual(['active', 'ready']);
    expect([...LEGAL_TRANSITIONS.active].sort()).toEqual(['done', 'failed', 'ready']);
    expect([...LEGAL_TRANSITIONS.done]).toEqual([]);
    expect([...LEGAL_TRANSITIONS.failed]).toEqual([]);

    for (const from of ISSUE_STATES) {
      for (const to of ISSUE_STATES) {
        const legal = (LEGAL_TRANSITIONS[from] as readonly string[]).includes(to);
        if (legal) {
          expect(() => assertTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError);
        }
      }
    }
  });

  it('walks the happy path ready -> leased -> active -> done, applying patches', () => {
    const store = new IssueStore();
    const issue = store.add({ title: 'happy path' });

    store.transition(issue.id, 'leased', { leaseExpiresAt: 1500 }, 1000);
    expect(store.get(issue.id).leaseExpiresAt).toBe(1500);

    store.transition(issue.id, 'active', { branch: 'bot/issue-1-attempt-1' }, 1100);
    store.transition(issue.id, 'done', { prNumber: 9, leaseExpiresAt: null }, 1200);

    const final = store.get(issue.id);
    expect(final.state).toBe('done');
    expect(final.prNumber).toBe(9);
    expect(final.branch).toBe('bot/issue-1-attempt-1');
    expect(final.updatedAt).toBe(1200);
  });

  it('supports the watchdog recovery edges leased -> ready and active -> ready', () => {
    const store = new IssueStore();
    const leased = store.add({ title: 'leased one' });
    store.transition(leased.id, 'leased', { leaseExpiresAt: 100 }, 50);
    store.transition(leased.id, 'ready', { leaseExpiresAt: null }, 200);
    expect(store.get(leased.id).state).toBe('ready');

    const active = store.add({ title: 'active one' });
    store.transition(active.id, 'leased', { leaseExpiresAt: 100 }, 50);
    store.transition(active.id, 'active', {}, 60);
    store.transition(active.id, 'ready', { leaseExpiresAt: null }, 200);
    expect(store.get(active.id).state).toBe('ready');
  });

  it('supports active -> failed', () => {
    const store = new IssueStore();
    const issue = store.add({ title: 'doomed' });
    store.transition(issue.id, 'leased', { leaseExpiresAt: 100 }, 50);
    store.transition(issue.id, 'active', {}, 60);
    store.transition(issue.id, 'failed', { lastError: 'nope' }, 70);
    expect(store.get(issue.id).state).toBe('failed');
    expect(store.get(issue.id).lastError).toBe('nope');
  });

  it('throws on illegal transitions, including anything out of terminal states', () => {
    const store = new IssueStore();
    const issue = store.add({ title: 'illegal' });
    expect(() => store.transition(issue.id, 'active')).toThrow(InvalidTransitionError);
    expect(() => store.transition(issue.id, 'done')).toThrow(InvalidTransitionError);
    expect(() => store.transition(issue.id, 'failed')).toThrow(InvalidTransitionError);
    expect(() => store.transition(issue.id, 'ready')).toThrow(InvalidTransitionError);

    store.transition(issue.id, 'leased', { leaseExpiresAt: 100 });
    expect(() => store.transition(issue.id, 'done')).toThrow(InvalidTransitionError);
    expect(() => store.transition(issue.id, 'failed')).toThrow(InvalidTransitionError);

    store.transition(issue.id, 'active', {});
    store.transition(issue.id, 'done', {});
    for (const to of ['ready', 'leased', 'active', 'failed'] as const) {
      expect(() => store.transition(issue.id, to)).toThrow(InvalidTransitionError);
    }

    const failed = store.add({ title: 'failed one' });
    store.transition(failed.id, 'leased', { leaseExpiresAt: 100 });
    store.transition(failed.id, 'active', {});
    store.transition(failed.id, 'failed', {});
    for (const to of ['ready', 'leased', 'active', 'done'] as const) {
      expect(() => store.transition(failed.id, to)).toThrow(InvalidTransitionError);
    }
  });

  it('claimNext sets a lease and claims in priority order, then insertion order', () => {
    const store = new IssueStore();
    const low = store.add({ title: 'low', priority: 5 });
    const high = store.add({ title: 'high', priority: 1 });
    const alsoHigh = store.add({ title: 'also high', priority: 1 });

    const first = store.claimNext(1000, 500);
    expect(first?.id).toBe(high.id);
    expect(first?.state).toBe('leased');
    expect(first?.leaseExpiresAt).toBe(1500);

    expect(store.claimNext(1000, 500)?.id).toBe(alsoHigh.id);
    expect(store.claimNext(1000, 500)?.id).toBe(low.id);
    expect(store.claimNext(1000, 500)).toBeNull();
  });

  it('lease expiry path: a burned active attempt requeues to ready and counts the attempt', () => {
    const store = new IssueStore({ maxAttempts: 3 });
    const issue = store.add({ title: 'flaky' });
    store.transition(issue.id, 'leased', { leaseExpiresAt: 100 }, 50);
    store.transition(issue.id, 'active', { leaseExpiresAt: 200 }, 60);

    const updated = store.recordAttemptFailure(issue.id, 'lease expired', 300);
    expect(updated.state).toBe('ready');
    expect(updated.attempts).toBe(1);
    expect(updated.leaseExpiresAt).toBeNull();
    expect(updated.lastError).toBe('lease expired');
  });

  it('attempts exhausted: an active issue becomes failed', () => {
    const store = new IssueStore({ maxAttempts: 2 });
    const issue = store.add({ title: 'always fails' });

    store.transition(issue.id, 'leased', { leaseExpiresAt: 100 });
    store.transition(issue.id, 'active', {});
    expect(store.recordAttemptFailure(issue.id, 'fail 1').state).toBe('ready');
    expect(store.get(issue.id).attempts).toBe(1);

    store.claimNext(200, 100);
    store.transition(issue.id, 'active', {});
    const final = store.recordAttemptFailure(issue.id, 'fail 2');
    expect(final.state).toBe('failed');
    expect(final.attempts).toBe(2);
    expect(isTerminal(final.state)).toBe(true);
  });

  it('attempts exhausted: a leased issue is failed via leased -> active -> failed', () => {
    const store = new IssueStore({ maxAttempts: 1 });
    const issue = store.add({ title: 'never started' });
    store.transition(issue.id, 'leased', { leaseExpiresAt: 100 });

    const final = store.recordAttemptFailure(issue.id, 'lease expired', 200);
    expect(final.state).toBe('failed');
    expect(final.attempts).toBe(1);
  });

  it('recordAttemptFailure rejects issues that are not leased/active', () => {
    const store = new IssueStore();
    const issue = store.add({ title: 'still ready' });
    expect(() => store.recordAttemptFailure(issue.id, 'x')).toThrow(/expected 'active' or 'leased'/);
  });

  it('isTerminal only for done/failed', () => {
    expect(isTerminal('done')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('ready')).toBe(false);
    expect(isTerminal('leased')).toBe(false);
    expect(isTerminal('active')).toBe(false);
  });
});
