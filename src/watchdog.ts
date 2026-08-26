import type { Logger } from './logger.js';
import type { IssueRecord, IssueStore } from './store.js';

/**
 * Reclaims issues whose lease expired (dispatcher crashed, executor hung):
 * every expired leased/active issue is requeued to `ready` with its attempt
 * counter incremented, or marked `failed` once attempts are exhausted.
 */
export class Watchdog {
  constructor(
    private readonly store: IssueStore,
    private readonly logger: Logger,
    private readonly nowFn: () => number = Date.now,
  ) {}

  /** One scan. Returns every issue it recovered, in its new state. */
  runOnce(now: number = this.nowFn()): IssueRecord[] {
    const recovered: IssueRecord[] = [];
    for (const issue of this.store.findExpiredLeases(now)) {
      const fromState = issue.state;
      const reason = `lease expired in state '${fromState}' (deadline ${String(issue.leaseExpiresAt)}, now ${now})`;
      const updated = this.store.recordAttemptFailure(issue.id, reason, now);
      this.logger.warn('watchdog recovered expired issue', {
        issueId: issue.id,
        fromState,
        toState: updated.state,
        attempts: updated.attempts,
      });
      recovered.push(updated);
    }
    return recovered;
  }
}
