import type { AgentExecutor } from './agent/executor.js';
import type { GitHubAdapter } from './github/adapter.js';
import type { Logger } from './logger.js';
import type { IssueRecord, IssueStore } from './store.js';
import type { TestGate } from './test-gate.js';

export interface MergeRecord {
  issueId: string;
  issueNumber: number;
  title: string;
  branch: string;
  prNumber: number;
  mergedAt: number;
}

export interface DispatcherOptions {
  /** Max issues worked on concurrently. */
  maxConcurrent: number;
  /** Lease granted on claim; if the executor never starts, the watchdog reclaims. */
  leaseMs: number;
  /** Lease granted once active; bounds one execution attempt. */
  executionTimeoutMs: number;
  /** Working copy of the target repository. */
  workDir: string;
  baseBranch: string;
  /** Called after every successful PR merge (the monitor hooks in here). */
  onMerged?: (merge: MergeRecord) => void;
}

/**
 * Claims ready issues through the state machine and drives each one through
 * a pipeline: leased -> active -> branch -> execute -> test gate -> PR ->
 * merge -> done. Test-gate or executor failures go through
 * `recordAttemptFailure` (retry while attempts remain, then `failed`).
 */
export class Dispatcher {
  private readonly pipelines = new Set<Promise<void>>();

  constructor(
    private readonly store: IssueStore,
    private readonly adapter: GitHubAdapter,
    private readonly executor: AgentExecutor,
    private readonly gate: TestGate,
    private readonly opts: DispatcherOptions,
    private readonly logger: Logger,
  ) {}

  /** Number of issues currently being worked (leased or active). */
  get inflight(): number {
    return this.pipelines.size;
  }

  /**
   * Claim ready issues up to the concurrency limit and launch a pipeline for
   * each. Returns how many pipelines were launched. Never blocks.
   */
  poll(now: number = Date.now()): number {
    let launched = 0;
    while (this.pipelines.size < this.opts.maxConcurrent) {
      const issue = this.store.claimNext(now, this.opts.leaseMs);
      if (!issue) break;
      launched += 1;
      this.launch(issue, now);
    }
    return launched;
  }

  /** Resolve once every in-flight pipeline has settled. */
  async drain(): Promise<void> {
    while (this.pipelines.size > 0) {
      await Promise.allSettled([...this.pipelines]);
    }
  }

  private launch(issue: IssueRecord, now: number): void {
    this.logger.info('issue claimed', {
      issueId: issue.id,
      issueNumber: issue.issueNumber,
      title: issue.title,
      attempt: issue.attempts + 1,
    });
    const pipeline = this.runPipeline(issue, now).catch((err: unknown) => {
      this.logger.error('pipeline crashed', {
        issueId: issue.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    this.pipelines.add(pipeline);
    void pipeline.finally(() => {
      this.pipelines.delete(pipeline);
    });
  }

  private async runPipeline(issue: IssueRecord, now: number): Promise<void> {
    const branch = `bot/issue-${issue.issueNumber}-attempt-${issue.attempts + 1}`;
    try {
      // leased -> active happens synchronously, before the first await, so a
      // claimed issue can never be reclaimed by the watchdog mid-launch.
      this.store.transition(
        issue.id,
        'active',
        { branch, leaseExpiresAt: now + this.opts.executionTimeoutMs },
        now,
      );
      await this.adapter.createBranch(branch, this.opts.baseBranch);
      const result = await this.executor.execute({
        issue: this.store.get(issue.id),
        workDir: this.opts.workDir,
        branch,
      });
      const gate = await this.gate.run();
      if (!gate.ok) {
        const tail = gate.stderr.trim() || gate.stdout.trim();
        throw new Error(`test gate failed (exit ${String(gate.exitCode)}): ${tail.slice(0, 500)}`);
      }
      const pr = await this.adapter.createPullRequest({
        title: `[bot] ${issue.title}`,
        body: [
          `Resolves issue #${issue.issueNumber}.`,
          '',
          result.summary,
          '',
          `Changed files: ${result.changedFiles.join(', ') || 'none'}`,
        ].join('\n'),
        head: branch,
        base: this.opts.baseBranch,
      });
      await this.adapter.mergePullRequest(pr.number);
      this.store.transition(issue.id, 'done', { prNumber: pr.number, leaseExpiresAt: null });
      this.logger.info('issue done', { issueId: issue.id, prNumber: pr.number });
      this.opts.onMerged?.({
        issueId: issue.id,
        issueNumber: issue.issueNumber,
        title: issue.title,
        branch,
        prNumber: pr.number,
        mergedAt: Date.now(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn('attempt failed', { issueId: issue.id, error: message });
      this.store.recordAttemptFailure(issue.id, message);
    }
  }
}
