import { createHash } from 'node:crypto';
import path from 'node:path';
import type { CommunityCollector, CommunityScanResult } from './community/collector.js';
import type { ProjectConfig, RewardScorecard, RunCheckpoint, TaskRecord } from './core/types.js';
import { redactText } from './core/ledger.js';
import { PersistentTaskStore } from './core/persistent-store.js';
import { REQUIRED_GITHUB_CHECKS, type GitHubControl } from './github/control-plane.js';
import { GitWorkspace, branchFor } from './git/git-workspace.js';
import { parseNormalizedSpec, type TaskNormalizer } from './intake/normalizer.js';
import { Logger } from './logger.js';
import { matchesPortfolioTaskContract, PortfolioCoordinator } from './portfolio/coordinator.js';
import type { QwenExecutor } from './qwen/qwen-code-executor.js';
import { UniversalRewardEngine } from './rewards/engine.js';
import { resolveVisualArtifacts } from './rewards/evaluators.js';
import { GateRunner } from './rewards/gates.js';
import { prepareProjectCheckout } from './runtime/checkout-preflight.js';

const RECONCILIATION_STATES = ['pr_open', 'waiting_ci', 'merge_ready', 'post_merge'] as const;

export interface SupervisorTickResult {
  community: CommunityScanResult;
  ingested: number;
  recovered: number;
  processedTaskId: string | null;
  action: string;
}

export class HarnessSupervisor {
  constructor(
    private readonly config: ProjectConfig,
    private readonly store: PersistentTaskStore,
    private readonly github: GitHubControl,
    private readonly git: GitWorkspace,
    private readonly qwen: QwenExecutor,
    private readonly normalizer: TaskNormalizer,
    private readonly gates: GateRunner,
    private readonly rewards: UniversalRewardEngine,
    private readonly logger: Logger,
    private readonly workerId: string,
    private readonly community?: CommunityCollector,
  ) {}

  async tick(signal?: AbortSignal): Promise<SupervisorTickResult> {
    try {
      const recovered = await this.recoverExpiredLeases();
      this.resumeProviderWaits();
      const community = this.community
        ? await this.community.scan()
        : { checked: 0, changed: 0, created: 0, skipped: 0, failed: 0 };
      const ingested = await this.syncIntake();
      if (signal?.aborted) {
        return { community, ingested, recovered, processedTaskId: null, action: 'interrupted' };
      }

      const reconciled = await this.reconcilePending(signal);
      if (signal?.aborted) {
        return { community, ingested, recovered, processedTaskId: reconciled.at(-1)?.id ?? null, action: 'interrupted' };
      }

      const task = this.store.claimNext(this.workerId, this.config.worker.leaseMs);
      if (!task) {
        const latest = reconciled.at(-1);
        return {
          community,
          ingested,
          recovered,
          processedTaskId: latest?.id ?? null,
          action: latest ? `reconciled:${reconciled.length}:${latest.state}` : 'idle',
        };
      }
      this.store.recordEvent('task.active_started', task.id, { phase: 'implementation' });
      try {
        await this.executeTask(task, signal);
      } finally {
        this.store.recordEvent('task.active_finished', task.id, { phase: 'implementation' });
      }
      return { community, ingested, recovered, processedTaskId: task.id, action: 'executed' };
    } finally {
      const portfolioPlans = this.store.listPortfolioPlans().filter((plan) =>
        ['approving', 'active', 'blocked'].includes(plan.status),
      );
      if (!signal?.aborted && portfolioPlans.length > 0) {
        try {
          const coordinator = new PortfolioCoordinator(this.config, this.store, this.github);
          for (const plan of portfolioPlans) await coordinator.refresh(plan.id);
        } catch (error) {
          this.logger.warn('portfolio status refresh failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  async syncIntake(): Promise<number> {
    const issues = await this.github.listOpenIssues();
    let ingested = 0;
    for (const issue of issues) {
      const parsed = parseNormalizedSpec(issue.body);
      const trusted = this.config.intake.trustedAuthors.includes(issue.author);
      const normalized = issue.labels.includes(this.config.intake.normalizedLabel) && parsed;
      if (normalized && trusted) {
        const portfolioLink = this.store.listPortfolioPlans().flatMap((plan) =>
          plan.stories
            .filter((story) => story.normalizedIssueNumber === issue.number)
            .map((story) => ({ plan, story })),
        )[0];
        if (portfolioLink && !matchesPortfolioTaskContract(portfolioLink.plan, portfolioLink.story, parsed)) {
          const idempotencyKey = `portfolio:contract-rejected:${issue.number}:${sha256(issue.body)}`;
          this.store.recordEvent('portfolio.contract_rejected', null, {
            planId: portfolioLink.plan.id,
            storyKey: portfolioLink.story.key,
            issueNumber: issue.number,
          }, idempotencyKey);
          this.logger.warn('edited portfolio task contract rejected', {
            planId: portfolioLink.plan.id,
            storyKey: portfolioLink.story.key,
            issueNumber: issue.number,
          });
          continue;
        }
        const existing = this.store.findByIssue(issue.number);
        const lineage = existing ? null : repairLineage(issue.body, this.store);
        const task = this.store.upsert({
          issueNumber: issue.number,
          title: issue.title,
          body: issue.body,
          labels: issue.labels,
          author: issue.author,
          state: existing?.state ?? 'normalized',
          spec: parsed,
          maxAttempts: this.config.worker.maxAttempts,
          failureLineageId: lineage?.failureLineageId ?? null,
          lineageFailures: lineage?.lineageFailures ?? 0,
          identicalFailures: lineage?.identicalFailures ?? 0,
          lastFailureFingerprint: lineage?.lastFailureFingerprint ?? null,
        });
        if (task.state === 'intake') this.store.transition(task.id, 'normalized', { spec: parsed });
        const current = this.store.get(task.id);
        if (current.state === 'normalized') this.store.transition(task.id, 'ready');
        ingested += existing ? 0 : 1;
        continue;
      }

      const selfRepair =
        trusted && issue.labels.includes('self-repair') && this.config.intake.autoPromoteSelfRepair;
      const community = issue.labels.includes(this.config.intake.communityLabel);
      const approved = issue.labels.includes(this.config.intake.approvalLabel);
      if (!approved && !selfRepair) continue;
      if (
        issues.some(
          (candidate) =>
            candidate.number !== issue.number &&
            candidate.labels.includes(this.config.intake.normalizedLabel) &&
            this.config.intake.trustedAuthors.includes(candidate.author) &&
            parseNormalizedSpec(candidate.body) !== null &&
            candidate.body.includes(`Source: #${issue.number} (`),
        )
      ) {
        continue;
      }
      const key = `normalize:${issue.number}:${sha256(`${issue.title}\n${issue.body}`)}`;
      if (this.store.hasIdempotencyKey(key)) continue;

      const sourceKind = selfRepair ? 'self-repair' : community ? 'community' : 'user';
      const result = await this.normalizer.normalize(issue, sourceKind);
      const created = await this.github.createIssue({
        title: `[harness] ${result.title}`,
        body: result.body,
        labels: [this.config.intake.normalizedLabel, this.config.intake.readyLabel],
      });
      this.store.recordEvent('intake.normalized', null, { sourceIssue: issue.number, normalizedIssue: created.number }, key);
      await this.github.comment(issue.number, `Normalized for autonomous execution as #${created.number}.`);
      const lineage = selfRepair ? repairLineage(issue.body, this.store) : null;
      this.store.upsert({
        issueNumber: created.number,
        title: created.title,
        body: created.body,
        labels: created.labels,
        author: created.author,
        state: 'normalized',
        spec: result.spec,
        maxAttempts: this.config.worker.maxAttempts,
        failureLineageId: lineage?.failureLineageId ?? null,
        lineageFailures: lineage?.lineageFailures ?? 0,
        identicalFailures: lineage?.identicalFailures ?? 0,
        lastFailureFingerprint: lineage?.lastFailureFingerprint ?? null,
      });
      const task = this.store.findByIssue(created.number) as TaskRecord;
      this.store.transition(task.id, 'ready');
      ingested += 1;
    }
    return ingested;
  }

  private async executeTask(claimed: TaskRecord, signal?: AbortSignal): Promise<void> {
    let task = claimed;
    let executionHeartbeatTimer: NodeJS.Timeout | null = null;
    try {
      const branch = task.branch ?? branchFor(task);
      const worktree = await this.git.createOrResume({ ...task, branch });
      task = this.store.transition(task.id, 'active', {
        branch,
        baseSha: worktree.baseSha,
        worktreePath: worktree.path,
      });
      this.checkpoint(task, { reusedWorktree: worktree.reused });

      let lastHeartbeat = 0;
      const heartbeatInterval = Math.max(1_000, Math.min(30_000, Math.floor(this.config.worker.leaseMs / 3)));
      const heartbeat = (): void => {
        const now = Date.now();
        if (now - lastHeartbeat < Math.max(500, Math.floor(heartbeatInterval / 2))) return;
        lastHeartbeat = now;
        this.store.heartbeat(task.id, this.workerId, this.config.worker.leaseMs, now);
      };
      executionHeartbeatTimer = setInterval(heartbeat, heartbeatInterval);
      executionHeartbeatTimer.unref();
      await prepareProjectCheckout(worktree.path, signal);
      const qwenResult = await this.qwen.execute({
        task,
        worktree: worktree.path,
        feedback: task.lastError ? [task.lastError] : [],
        onHeartbeat: heartbeat,
        onSession: (sessionId) => {
          if (this.store.get(task.id).qwenSessionId !== sessionId) this.store.patch(task.id, { qwenSessionId: sessionId });
        },
        signal,
      });
      task = this.store.patch(task.id, {
        qwenSessionId: qwenResult.sessionId,
        qwenWorkflowRunId: qwenResult.workflowRunId,
      });
      if (qwenResult.needsContinuation) {
        const continuations = (task.continuations ?? 0) + 1;
        this.checkpoint(task, {
          goalState: qwenResult.goalState,
          goalReason: qwenResult.goalReason,
          usage: qwenResult.usage,
          continuations,
        });
        if (qwenResult.continuationKind === 'provider') {
          const resumeAfter = Date.now() + Math.max(this.config.worker.pollIntervalMs, 30_000);
          this.store.transition(task.id, 'waiting', {
            continuations,
            waitKind: 'provider',
            resumeAfter,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: qwenResult.goalReason ?? 'Qwen provider is temporarily unavailable',
          });
          this.store.recordEvent('task.provider_wait', task.id, { continuations, resumeAfter, reason: qwenResult.goalReason });
        } else if (continuations >= this.config.worker.maxContinuations) {
          this.store.patch(task.id, { continuations });
          this.store.recordFailure(
            task.id,
            `Qwen paused ${continuations} consecutive times without completing the goal; last reason: ${qwenResult.goalReason ?? 'budget or provider wait'}`,
            this.config.worker.identicalFailureLimit,
          );
        } else {
          this.store.transition(task.id, 'ready', {
            continuations,
            waitKind: null,
            resumeAfter: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: null,
          });
        }
        return;
      }

      task = this.store.transition(task.id, 'verifying');
      const changedBeforeCommit = await this.git.changedFiles(worktree.path);
      this.git.assertNoProtectedChanges(changedBeforeCommit);
      const commitSha = await this.git.commitCandidate(worktree.path, task, qwenResult.summary);
      task = this.store.patch(task.id, { commitSha });
      const changedFiles = await this.git.filesChangedBetween(worktree.path, task.baseSha as string, commitSha);
      this.git.assertNoProtectedChanges(changedFiles);
      const diff = await this.git.diff(worktree.path, task.baseSha as string, commitSha);
      const verificationPath = await this.git.createDetachedWorktree(
        commitSha,
        `candidate-${task.issueNumber}-${commitSha.slice(0, 12)}`,
      );
      let scorecard: RewardScorecard;
      try {
        await prepareProjectCheckout(verificationPath, signal);
        const gateResults = await this.gates.runAll(this.config.gates, verificationPath, changedFiles, signal);
        const failedGate = gateResults.find((gate) => gate.required && gate.applicable && !gate.ok);
        if (failedGate) {
          throw new Error(`Gate ${failedGate.id} failed: ${(failedGate.stderr || failedGate.stdout).slice(-1_500)}`);
        }
        const sideEffectFailure = await this.gateSideEffectFailure(verificationPath);
        if (sideEffectFailure) throw new Error(sideEffectFailure);
        scorecard = await this.rewards.evaluate({
          config: this.config,
          task,
          worktree: verificationPath,
          commitSha,
          changedFiles,
          diff,
          gateResults,
          signal,
        });
      } finally {
        await this.git.removeOwnedWorktree(verificationPath, { allowDirty: true });
      }
      this.store.saveScorecard(scorecard);
      if (!scorecard.passed) {
        throw new Error(`Reward verification failed: ${scorecard.blockingReasons.join('; ')}`);
      }
      throwIfAborted(signal);
      await this.git.pushCandidate(worktree.path, task.branch as string, commitSha);
      await this.publishRewardCheck(scorecard);

      throwIfAborted(signal);
      const pr = await this.github.createPullRequest({
        title: `[harness] ${task.title}`,
        body: renderPullRequestBody(task, qwenResult.summary, scorecard),
        head: task.branch as string,
        headSha: task.commitSha as string,
        base: this.config.project.defaultBranch,
      });
      task = this.store.transition(task.id, 'pr_open', {
        prNumber: pr.number,
        prUrl: pr.url,
        leaseOwner: this.workerId,
        leaseExpiresAt: Date.now() + this.config.worker.leaseMs,
      });
      clearInterval(executionHeartbeatTimer);
      executionHeartbeatTimer = null;
      this.checkpoint(task, { prNumber: pr.number, commitSha });
      await this.reconcileWithLease(task, signal);
    } catch (error) {
      if (signal?.aborted) this.releaseInterruptedTask(task.id);
      else await this.failAttempt(task.id, error);
    } finally {
      if (executionHeartbeatTimer) clearInterval(executionHeartbeatTimer);
    }
  }

  private releaseInterruptedTask(taskId: string): void {
    const current = this.store.get(taskId);
    if (!['leased', 'active', 'verifying'].includes(current.state)) return;
    const message = 'Worker shutdown interrupted the prior attempt; inspect the existing worktree and continue from its saved Qwen session.';
    const released = this.store.transition(taskId, 'ready', {
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: message,
    });
    this.store.recordEvent('task.interrupted', taskId, {
      from: current.state,
      qwenSessionId: released.qwenSessionId,
    });
    this.logger.info('task released after worker shutdown', { taskId, from: current.state });
  }

  private async reconcilePending(signal?: AbortSignal): Promise<TaskRecord[]> {
    const reconciled: TaskRecord[] = [];
    for (let index = 0; index < 20; index += 1) {
      if (signal?.aborted) break;
      const task = this.store.claimReconciliation(
        this.workerId,
        this.config.worker.leaseMs,
        [...RECONCILIATION_STATES],
        Date.now(),
        reconciled.map((candidate) => candidate.id),
      );
      if (!task) break;
      this.store.recordEvent('task.active_started', task.id, { phase: 'reconciliation', state: task.state });
      try {
        await this.reconcileWithLease(task, signal);
      } catch (error) {
        const current = this.store.get(task.id);
        if (signal?.aborted) {
          this.store.recordEvent('task.reconciliation_interrupted', task.id, { state: current.state });
        } else if (current.state === 'post_merge') {
          const message = error instanceof Error ? error.message : String(error);
          const updated = this.store.recordPostMergeFailure(
            task.id,
            message,
            this.config.worker.identicalFailureLimit,
          );
          this.logger.warn('post-merge verification retry scheduled', {
            taskId: task.id,
            state: updated.state,
            attempts: updated.attempts,
            error: message,
          });
        } else {
          await this.failAttempt(task.id, error);
        }
      } finally {
        this.store.recordEvent('task.active_finished', task.id, { phase: 'reconciliation' });
      }
      reconciled.push(this.store.get(task.id));
    }
    return reconciled;
  }

  private async reconcileWithLease(task: TaskRecord, signal?: AbortSignal): Promise<void> {
    const intervalMs = Math.max(1_000, Math.min(30_000, Math.floor(this.config.worker.leaseMs / 3)));
    const heartbeat = (): void => {
      const current = this.store.get(task.id);
      if (current.leaseOwner === this.workerId && RECONCILIATION_STATES.includes(current.state as (typeof RECONCILIATION_STATES)[number])) {
        this.store.heartbeat(task.id, this.workerId, this.config.worker.leaseMs);
      }
    };
    const timer = setInterval(heartbeat, intervalMs);
    timer.unref();
    try {
      if (task.state === 'post_merge') await this.runPostMerge(task, signal);
      else await this.reconcilePullRequest(task, signal);
    } finally {
      clearInterval(timer);
      const current = this.store.get(task.id);
      if (
        current.leaseOwner === this.workerId &&
        RECONCILIATION_STATES.includes(current.state as (typeof RECONCILIATION_STATES)[number])
      ) {
        this.store.patch(task.id, { leaseOwner: null, leaseExpiresAt: null });
      }
    }
  }

  private async reconcilePullRequest(task: TaskRecord, signal?: AbortSignal): Promise<void> {
    if (!task.prNumber || !task.commitSha) throw new Error('PR reconciliation requires prNumber and commitSha');
    const pr = await this.github.getPullRequest(task.prNumber);
    if (pr.headSha !== task.commitSha) throw new Error(`PR #${pr.number} head changed after reward verification`);
    if (pr.merged) {
      if (!pr.mergeCommitSha) throw new Error(`Merged PR #${pr.number} has no merge commit SHA yet`);
      if (task.state !== 'post_merge') {
        task = this.store.transition(task.id, 'post_merge', {
          mergeSha: pr.mergeCommitSha,
          leaseOwner: this.workerId,
          leaseExpiresAt: Date.now() + this.config.worker.leaseMs,
        });
      }
      await this.runPostMerge(task, signal);
      return;
    }
    if (pr.state === 'closed') throw new Error(`PR #${pr.number} was closed without merging`);

    if (task.state === 'merge_ready') {
      if (!this.config.worker.autoMerge) return;
      throwIfAborted(signal);
      await this.merge(task, signal);
      return;
    }

    const checks = await this.github.checksForRef(task.commitSha, [...REQUIRED_GITHUB_CHECKS]);
    if (checks.failed.length > 0) throw new Error(`GitHub checks failed: ${checks.failed.join(', ')}`);
    if (!checks.complete) {
      if (task.state === 'pr_open') this.store.transition(task.id, 'waiting_ci');
      return;
    }
    task = this.store.transition(task.id, 'merge_ready');
    if (!this.config.worker.autoMerge) {
      const key = `merge-ready:${task.id}:${task.commitSha}`;
      if (!this.store.hasIdempotencyKey(key)) {
        await this.github.comment(task.prNumber as number, 'All configured gates and Qwen reward checks passed. Auto-merge is disabled; ready for human merge.');
        this.store.recordEvent('pr.merge_ready', task.id, { prNumber: task.prNumber }, key);
      }
      return;
    }
    throwIfAborted(signal);
    await this.merge(task, signal);
  }

  private async merge(task: TaskRecord, signal?: AbortSignal): Promise<void> {
    const result = await this.github.mergePullRequest(task.prNumber as number, task.commitSha as string);
    if (!result.merged || !result.sha) throw new Error(`GitHub refused merge: ${result.message}`);
    const postMerge = this.store.transition(task.id, 'post_merge', {
      mergeSha: result.sha,
      leaseOwner: this.workerId,
      leaseExpiresAt: Date.now() + this.config.worker.leaseMs,
    });
    await this.runPostMerge(postMerge, signal);
  }

  private async runPostMerge(task: TaskRecord, signal?: AbortSignal): Promise<void> {
    if (!task.mergeSha) throw new Error('Post-merge verification requires mergeSha');
    const verificationPath = await this.git.createDetachedWorktree(task.mergeSha, `postmerge-${task.issueNumber}`);
    let failure: string | null = null;
    try {
      await prepareProjectCheckout(verificationPath, signal);
      const results = await this.gates.runAll(this.config.gates, verificationPath, [], signal);
      throwIfAborted(signal);
      const failed = results.filter((gate) => gate.required && gate.applicable && !gate.ok);
      if (failed.length > 0) failure = failed.map((gate) => `${gate.id}: ${(gate.stderr || gate.stdout).slice(-700)}`).join('\n');
      const sideEffectFailure = await this.gateSideEffectFailure(verificationPath);
      if (!failure && sideEffectFailure) failure = sideEffectFailure;
    } finally {
      await this.git.removeOwnedWorktree(verificationPath, { allowDirty: true });
    }
    if (failure) {
      failure = redactText(failure);
      const key = `postmerge-repair:${task.id}:${task.mergeSha}`;
      if (!this.store.hasIdempotencyKey(key)) {
        const title = `[self-repair] Post-merge regression at ${task.mergeSha.slice(0, 12)}`;
        const existing = (await this.github.listOpenIssues()).find(
          (issue) => issue.title === title && issue.labels.includes('self-repair'),
        );
        const issue =
          existing ??
          (await this.github.createIssue({
            title,
            body: [
              `Post-merge verification failed for PR #${task.prNumber}.`,
              `Origin task: #${task.issueNumber}`,
              `Merge commit: ${task.mergeSha}`,
              '',
              'Failure evidence:',
              '```text',
              failure,
              '```',
            ].join('\n'),
            labels: ['self-repair', this.config.intake.approvalLabel],
          }));
        this.store.recordEvent(
          existing ? 'postmerge.repair_reused' : 'postmerge.repair_created',
          task.id,
          { issueNumber: issue.number },
          key,
        );
      }
    }
    const finished = this.store.transition(task.id, failure ? 'failed' : 'done', {
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: failure,
    });
    if (finished.worktreePath) {
      try {
        await this.git.removeOwnedWorktree(finished.worktreePath);
      } catch (error) {
        this.logger.warn('worktree cleanup deferred', { taskId: finished.id, error: String(error) });
      }
    }
  }

  private async gateSideEffectFailure(worktree: string): Promise<string | null> {
    const sideEffects = await this.git.changedFiles(worktree);
    if (sideEffects.length === 0) return null;
    const patterns = this.config.rewards.criteria.flatMap((criterion) =>
      criterion.modality === 'visual' ? criterion.artifactGlobs ?? [] : [],
    );
    const allowed = new Set(
      resolveVisualArtifacts(worktree, patterns).map((artifact) =>
        path.relative(worktree, artifact).split('\\').join('/'),
      ),
    );
    const unexpected = sideEffects.filter((file) => !allowed.has(file.split('\\').join('/')));
    return unexpected.length > 0
      ? `Gates modified the exact verification worktree outside configured visual artifacts: ${unexpected.join(', ')}`
      : null;
  }

  private async recoverExpiredLeases(): Promise<number> {
    const expired = this.store.expired();
    for (const task of expired) {
      if (['pr_open', 'waiting_ci', 'merge_ready', 'post_merge'].includes(task.state)) {
        this.store.patch(task.id, { leaseOwner: null, leaseExpiresAt: null });
        this.store.recordEvent('task.reconciliation_recovered', task.id, { state: task.state });
        this.logger.warn('expired reconciliation lease cleared', { taskId: task.id, state: task.state });
        continue;
      }
      const result = this.store.recordFailure(
        task.id,
        `Lease expired while task was ${task.state}; recovery will reconcile existing Git and GitHub state.`,
        this.config.worker.identicalFailureLimit,
      );
      this.store.recordEvent('task.execution_recovered', task.id, { from: task.state, to: result.state });
      this.logger.warn('expired task recovered', { taskId: task.id, from: task.state, to: result.state });
    }
    return expired.length;
  }

  private resumeProviderWaits(now = Date.now()): number {
    const waiting = this.store.list(['waiting']).filter((task) =>
      task.waitKind === 'provider' && task.resumeAfter !== null && task.resumeAfter !== undefined && task.resumeAfter <= now,
    );
    for (const task of waiting) {
      this.store.transition(task.id, 'ready', { waitKind: null, resumeAfter: null, lastError: null });
      this.store.recordEvent('task.provider_resumed', task.id, { continuations: task.continuations ?? 0 });
    }
    return waiting.length;
  }

  private async failAttempt(taskId: string, error: unknown): Promise<void> {
    const message = redactText(error instanceof Error ? error.message : String(error));
    const task = this.store.get(taskId);
    if (['done', 'failed', 'cancelled', 'quarantined'].includes(task.state)) return;
    const updated = this.store.recordFailure(taskId, message, this.config.worker.identicalFailureLimit);
    this.logger.warn('task attempt failed', { taskId, state: updated.state, attempts: updated.attempts, error: message });
    if (updated.prNumber) {
      const key = `attempt-failed:${taskId}:${updated.attempts}:${updated.lastFailureFingerprint}`;
      if (!this.store.hasIdempotencyKey(key)) {
        await this.github.comment(updated.prNumber, `Harness attempt ${updated.attempts} failed and was routed for repair:\n\n\`${message.slice(0, 1_500)}\``);
        this.store.recordEvent('task.failure_reported', taskId, { attempts: updated.attempts }, key);
      }
    }
  }

  private checkpoint(task: TaskRecord, payload: Record<string, unknown>): void {
    const checkpoint: RunCheckpoint = {
      taskId: task.id,
      phase: task.state,
      qwenSessionId: task.qwenSessionId,
      qwenWorkflowRunId: task.qwenWorkflowRunId,
      baseSha: task.baseSha,
      commitSha: task.commitSha,
      payload,
      createdAt: Date.now(),
    };
    this.store.saveCheckpoint(checkpoint);
  }

  private async publishRewardCheck(scorecard: RewardScorecard): Promise<void> {
    await this.github.publishCheck({
      name: 'Fern Delivery Harness / reward',
      sha: scorecard.commitSha,
      conclusion: scorecard.passed ? 'success' : 'failure',
      title: scorecard.passed ? 'Universal reward passed' : 'Universal reward failed',
      summary: `Score ${scorecard.aggregateScore.toFixed(3)} / threshold ${scorecard.aggregateThreshold.toFixed(3)}`,
      text: scorecard.criteria
        .map((criterion) => `${criterion.passed ? 'PASS' : 'FAIL'} ${criterion.id}: ${criterion.score.toFixed(3)} — ${criterion.reason}`)
        .join('\n'),
      externalId: scorecard.id,
    });
  }

}

function repairLineage(body: string, store: PersistentTaskStore): Pick<TaskRecord, 'failureLineageId' | 'lineageFailures' | 'identicalFailures' | 'lastFailureFingerprint'> | null {
  const originIssue = /Origin task:\s*#(\d+)/i.exec(body)?.[1];
  if (!originIssue) return null;
  const origin = store.findByIssue(Number(originIssue));
  if (!origin) return null;
  return {
    failureLineageId: origin.failureLineageId ?? origin.id,
    lineageFailures: origin.lineageFailures ?? 0,
    identicalFailures: origin.identicalFailures,
    lastFailureFingerprint: origin.lastFailureFingerprint,
  };
}

function renderPullRequestBody(task: TaskRecord, summary: string, scorecard: RewardScorecard): string {
  return [
    `Resolves #${task.issueNumber}.`,
    '',
    '## Result',
    summary,
    '',
    '## Verification',
    `- Commit: \`${scorecard.commitSha}\``,
    `- Hard gates: ${scorecard.hardGatePass ? 'passed' : 'failed'}`,
    `- Reward: ${scorecard.aggregateScore.toFixed(3)} / ${scorecard.aggregateThreshold.toFixed(3)}`,
    '',
    'Generated by the Qwen autonomous harness. Exact-head GitHub checks remain authoritative.',
  ].join('\n');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Worker shutdown interrupted the active operation');
}
