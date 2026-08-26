import type { TaskState } from './types.js';

export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  intake: ['normalized', 'cancelled'],
  normalized: ['ready', 'cancelled'],
  ready: ['leased', 'cancelled'],
  leased: ['active', 'ready', 'waiting', 'failed', 'quarantined', 'cancelled'],
  active: ['verifying', 'ready', 'waiting', 'failed', 'quarantined', 'cancelled'],
  verifying: ['pr_open', 'ready', 'waiting', 'failed', 'quarantined', 'cancelled'],
  pr_open: ['waiting_ci', 'merge_ready', 'post_merge', 'ready', 'waiting', 'failed', 'quarantined', 'cancelled'],
  waiting_ci: ['merge_ready', 'post_merge', 'ready', 'waiting', 'failed', 'quarantined', 'cancelled'],
  merge_ready: ['post_merge', 'done', 'ready', 'waiting', 'failed', 'quarantined', 'cancelled'],
  post_merge: ['done', 'ready', 'waiting', 'failed', 'quarantined'],
  waiting: ['ready', 'failed', 'quarantined', 'cancelled'],
  failed: [],
  quarantined: ['ready', 'cancelled'],
  cancelled: [],
  done: [],
};

export class InvalidTaskTransitionError extends Error {
  constructor(
    public readonly from: TaskState,
    public readonly to: TaskState,
  ) {
    super(`Invalid task state transition: ${from} -> ${to}`);
    this.name = 'InvalidTaskTransitionError';
  }
}

export function assertTaskTransition(from: TaskState, to: TaskState): void {
  if (!TASK_TRANSITIONS[from].includes(to)) throw new InvalidTaskTransitionError(from, to);
}

export function isTaskTerminal(state: TaskState): boolean {
  return state === 'done' || state === 'failed' || state === 'cancelled';
}

export function isTaskLeased(state: TaskState): boolean {
  return ['leased', 'active', 'verifying', 'pr_open', 'waiting_ci', 'merge_ready', 'post_merge'].includes(state);
}
