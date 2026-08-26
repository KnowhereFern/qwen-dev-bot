import type { MergeRecord } from './dispatcher.js';
import type { GitHubAdapter } from './github/adapter.js';
import type { Logger } from './logger.js';
import type { IssueStore } from './store.js';
import type { TestGate } from './test-gate.js';

export interface PostMergeCheckResult {
  merge: MergeRecord;
  ok: boolean;
  repairIssueId?: string;
}

/**
 * Self-repair monitor. After every PR merge it runs the post-merge checks
 * against the base branch. When a check fails it opens a labeled `self-repair`
 * issue (linked to the offending PR/branch) that re-enters the same state
 * machine and is resolved by the normal loop.
 */
export class Monitor {
  private readonly queue: MergeRecord[] = [];
  readonly results: PostMergeCheckResult[] = [];

  constructor(
    private readonly adapter: GitHubAdapter,
    private readonly store: IssueStore,
    private readonly postMergeGate: TestGate,
    private readonly logger: Logger,
    private readonly opts: { maxAttempts?: number } = {},
  ) {}

  enqueue(merge: MergeRecord): void {
    this.queue.push(merge);
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Drain the merge queue, running post-merge checks once per merge. */
  async runOnce(): Promise<PostMergeCheckResult[]> {
    const batch: PostMergeCheckResult[] = [];
    let merge: MergeRecord | undefined;
    while ((merge = this.queue.shift()) !== undefined) {
      batch.push(await this.check(merge));
    }
    return batch;
  }

  private async check(merge: MergeRecord): Promise<PostMergeCheckResult> {
    const gate = await this.postMergeGate.run();
    if (gate.ok) {
      this.logger.info('post-merge checks passed', { prNumber: merge.prNumber });
      const result: PostMergeCheckResult = { merge, ok: true };
      this.results.push(result);
      return result;
    }

    this.logger.warn('post-merge checks failed; opening self-repair issue', {
      prNumber: merge.prNumber,
      exitCode: gate.exitCode,
    });
    const title = `Self-repair: post-merge checks failed after PR #${merge.prNumber}`;
    const body = [
      `Post-merge checks failed on the base branch after merging PR #${merge.prNumber} (\`${merge.branch}\`),`,
      `which resolved issue #${merge.issueNumber} ("${merge.title}").`,
      '',
      'Failing output (tail):',
      '```',
      (gate.stderr.trim() || gate.stdout.trim()).slice(0, 2000) || '(no output)',
      '```',
    ].join('\n');

    const remote = await this.adapter.createIssue({ title, body, labels: ['self-repair'] });
    const record = this.store.add({
      title,
      body,
      labels: ['self-repair'],
      issueNumber: remote.number,
      maxAttempts: this.opts.maxAttempts,
    });
    const result: PostMergeCheckResult = { merge, ok: false, repairIssueId: record.id };
    this.results.push(result);
    return result;
  }
}
