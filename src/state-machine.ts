/**
 * Issue state machine.
 *
 * States and the only legal transitions between them:
 *
 *   ready  -> leased   dispatcher claims the issue (sets a lease expiry)
 *   leased -> active   executor starts working
 *   active -> done     tests pass and the PR is merged
 *   active -> failed   attempts exhausted / unrecoverable executor error
 *   leased -> ready    lease expired before work started (watchdog recovery)
 *   active -> ready    execution timed out or the attempt failed and retries remain
 *
 * Anything else throws InvalidTransitionError. `done` and `failed` are terminal.
 */
export const ISSUE_STATES = ['ready', 'leased', 'active', 'done', 'failed'] as const;

export type IssueState = (typeof ISSUE_STATES)[number];

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: IssueState,
    public readonly to: IssueState,
  ) {
    super(`Invalid issue state transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export const LEGAL_TRANSITIONS: Readonly<Record<IssueState, readonly IssueState[]>> = {
  ready: ['leased'],
  leased: ['active', 'ready'],
  active: ['done', 'failed', 'ready'],
  done: [],
  failed: [],
};

export function isLegalTransition(from: IssueState, to: IssueState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: IssueState, to: IssueState): void {
  if (!isLegalTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(state: IssueState): boolean {
  return state === 'done' || state === 'failed';
}
