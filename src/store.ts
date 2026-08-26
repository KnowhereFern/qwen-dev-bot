import { assertTransition, type IssueState } from './state-machine.js';

export interface IssueRecord {
  /** Internal id, e.g. "iss_1". */
  id: string;
  /** Issue number in the GitHub adapter (remote). */
  issueNumber: number;
  title: string;
  body: string;
  labels: string[];
  state: IssueState;
  /** Number of failed/timed-out attempts so far. */
  attempts: number;
  maxAttempts: number;
  /** Lower values are claimed first; ties break by insertion order. */
  priority: number;
  /** Epoch ms after which a leased/active issue is considered abandoned. */
  leaseExpiresAt: number | null;
  branch: string | null;
  prNumber: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  /** Monotonic insertion sequence, used for stable ordering. */
  seq: number;
}

export interface NewIssueInput {
  title: string;
  body?: string;
  labels?: string[];
  priority?: number;
  maxAttempts?: number;
  issueNumber?: number;
}

type IssuePatch = Partial<Omit<IssueRecord, 'id' | 'state' | 'seq' | 'createdAt'>>;

/**
 * In-memory canonical store for every issue the bot knows about. The state
 * machine is enforced here: every mutation goes through `transition` (or a
 * helper built on it), so an illegal edge always throws.
 */
export class IssueStore {
  private readonly issues = new Map<string, IssueRecord>();
  private seq = 0;
  private readonly defaultMaxAttempts: number;

  constructor(opts: { maxAttempts?: number } = {}) {
    this.defaultMaxAttempts = opts.maxAttempts ?? 3;
  }

  add(input: NewIssueInput): IssueRecord {
    this.seq += 1;
    const now = Date.now();
    const issue: IssueRecord = {
      id: `iss_${this.seq}`,
      issueNumber: input.issueNumber ?? this.seq,
      title: input.title,
      body: input.body ?? '',
      labels: [...(input.labels ?? [])],
      state: 'ready',
      attempts: 0,
      maxAttempts: input.maxAttempts ?? this.defaultMaxAttempts,
      priority: input.priority ?? 0,
      leaseExpiresAt: null,
      branch: null,
      prNumber: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      seq: this.seq,
    };
    this.issues.set(issue.id, issue);
    return issue;
  }

  get(id: string): IssueRecord {
    const issue = this.issues.get(id);
    if (!issue) throw new Error(`Unknown issue id: ${id}`);
    return issue;
  }

  all(): IssueRecord[] {
    return [...this.issues.values()];
  }

  listByState(state: IssueState): IssueRecord[] {
    return this.all().filter((issue) => issue.state === state);
  }

  counts(): Record<IssueState, number> {
    const counts: Record<IssueState, number> = { ready: 0, leased: 0, active: 0, done: 0, failed: 0 };
    for (const issue of this.issues.values()) counts[issue.state] += 1;
    return counts;
  }

  /** Validated state transition; throws InvalidTransitionError on illegal edges. */
  transition(id: string, to: IssueState, patch: IssuePatch = {}, now: number = Date.now()): IssueRecord {
    const issue = this.get(id);
    assertTransition(issue.state, to);
    Object.assign(issue, patch);
    issue.state = to;
    issue.updatedAt = now;
    return issue;
  }

  /**
   * Atomically claim the next ready issue (priority, then insertion order).
   * Sets the lease expiry. Returns null when nothing claimable is ready.
   */
  claimNext(now: number = Date.now(), leaseMs: number): IssueRecord | null {
    const next = this.listByState('ready')
      .filter((issue) => issue.attempts < issue.maxAttempts)
      .sort((a, b) => a.priority - b.priority || a.seq - b.seq)[0];
    if (!next) return null;
    return this.transition(next.id, 'leased', { leaseExpiresAt: now + leaseMs }, now);
  }

  /** Leased/active issues whose lease deadline has passed. */
  findExpiredLeases(now: number = Date.now()): IssueRecord[] {
    return this.all().filter(
      (issue) =>
        (issue.state === 'leased' || issue.state === 'active') &&
        issue.leaseExpiresAt !== null &&
        issue.leaseExpiresAt <= now,
    );
  }

  /**
   * Records a burned attempt (test-gate failure, executor error, or expired
   * lease) for a leased/active issue: increments `attempts`, then requeues to
   * `ready` when retries remain, otherwise marks the issue `failed`.
   *
   * `leased` has no direct edge to `failed`, so an exhausted leased issue is
   * walked leased -> active -> failed: the claim itself burned the final
   * attempt without the executor ever starting.
   */
  recordAttemptFailure(id: string, error: string, now: number = Date.now()): IssueRecord {
    const issue = this.get(id);
    if (issue.state !== 'active' && issue.state !== 'leased') {
      throw new Error(`recordAttemptFailure: issue ${id} is '${issue.state}', expected 'active' or 'leased'`);
    }
    const attempts = issue.attempts + 1;
    const exhausted = attempts >= issue.maxAttempts;
    const patch: IssuePatch = { attempts, lastError: error, leaseExpiresAt: null };
    if (issue.state === 'active') {
      return this.transition(id, exhausted ? 'failed' : 'ready', patch, now);
    }
    if (exhausted) {
      this.transition(id, 'active', patch, now);
      return this.transition(id, 'failed', {}, now);
    }
    return this.transition(id, 'ready', patch, now);
  }
}
