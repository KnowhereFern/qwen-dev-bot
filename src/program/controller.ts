import { createHash } from 'node:crypto';
import path from 'node:path';
import type { PersistentTaskStore } from '../core/persistent-store.js';
import type {
  ObjectiveCoverage,
  PortfolioPlan,
  PortfolioStory,
  ProgramRevision,
  ProgramWorkType,
  ProjectConfig,
  RepositoryAssessment,
  TaskRecord,
} from '../core/types.js';
import { StagingDeploymentController } from '../deployment/controller.js';
import { EvolutionSignalCollector } from '../evolution/signals.js';
import { REQUIRED_POST_MERGE_GITHUB_CHECKS, type CheckSummary, type GitHubControl } from '../github/control-plane.js';
import type { Logger } from '../logger.js';
import { matchesPortfolioTaskContract, PortfolioCoordinator, RecoveryLineageError } from '../portfolio/coordinator.js';
import { PortfolioPlanner, readRequirementsDocument } from '../portfolio/planner.js';
import { runProcess } from '../runtime/safe-process.js';
import { AssessmentContractError, RepositoryAssessor } from './repository-assessor.js';

/** Same required checks pending longer than this after their first
 * observation escalate to recovery-blocked. */
const PENDING_CHECKS_ESCALATION_MS = 60 * 60 * 1_000;

/** Operator coverage challenge projected from a persisted
 * program.coverage_challenged event. */
interface CoverageChallenge {
  coverageId: string;
  reason: string;
  commitSha: string;
  files: string[];
  authorizationId: string;
  authorizedBy: string;
  planRevision: number;
  createdAt: number;
}

export interface ProgramTickResult {
  action: 'disabled' | 'idle' | 'deployed' | 'deployment-failed' | 'reassessed' | 'recovery-blocked' | 'checks-pending' | 'awaiting-material-approval' | 'delivered' | 'maintaining';
  planId: string | null;
  detail?: string;
  /** Explicit transient cause for otherwise terminal actions. A
   * recovery-blocked result caused by the pending-checks escalation is
   * retryable: it must not consume quarantine or signal triggers the way
   * lineage/contract recovery-blocked outcomes do. */
  cause?: 'pending-checks-escalation';
}

export class ProgramController {
  private readonly coordinator: PortfolioCoordinator;
  private readonly deployer: StagingDeploymentController;

  constructor(
    private readonly config: ProjectConfig,
    private readonly store: PersistentTaskStore,
    private readonly github: GitHubControl,
    private readonly assessor: RepositoryAssessor,
    private readonly planner: PortfolioPlanner,
    private readonly signals: EvolutionSignalCollector,
    deployer?: StagingDeploymentController,
    private readonly logger?: Logger,
  ) {
    this.coordinator = new PortfolioCoordinator(config, store, github);
    this.deployer = deployer ?? new StagingDeploymentController(config, store);
  }

  async tick(signal?: AbortSignal): Promise<ProgramTickResult> {
    if (!this.config.program.enabled) return { action: 'disabled', planId: null };
    await this.reconcileDeployments(signal);
    await this.scanSignalsIfDue();
    const plans = await this.coordinator.refresh();
    const plan = plans.find((candidate) => !['done', 'superseded'].includes(candidate.status));
    if (!plan) return { action: 'idle', planId: null };

    const quarantine = this.quarantinedWaveTask(plan);
    if (plan.status === 'blocked') {
      const exhausted = this.failedWaveTasks(plan).find((task) => {
        const budget = this.store.retryBudget(task.id);
        return budget.failures >= budget.limit;
      });
      if (exhausted) {
        const budget = this.store.retryBudget(exhausted.id);
        const detail = `Issue #${exhausted.issueNumber} exhausted its shared recovery budget (${budget.failures}/${budget.limit}). Automatic replacement work is blocked; review the failure evidence and explicitly authorize recovery before further attempts.`;
        const key = `program:recovery-budget:${plan.id}:${exhausted.id}:${budget.failures}:${budget.limit}`;
        if (!this.store.hasIdempotencyKey(key)) this.store.recordEvent('program.recovery_budget_exhausted', exhausted.id, { planId: plan.id, ...budget, detail }, key);
        return { action: 'recovery-blocked', planId: plan.id, detail };
      }
    }
    if (plan.status === 'blocked' && quarantine) {
      const key = `program:quarantine:${plan.id}:${quarantine.id}:${quarantine.identicalFailures}`;
      if (!this.store.hasIdempotencyKey(key)) {
        this.store.recordEvent('program.reassessment_requested', quarantine.id, { planId: plan.id, reason: 'quarantine' });
        let result: ProgramTickResult;
        try {
          result = await this.reassess(plan, 'quarantine', signal);
        } catch (error) {
          if (!(error instanceof RecoveryLineageError) && !(error instanceof AssessmentContractError)) throw error;
          this.store.recordEvent('program.revision_rejected', quarantine.id, {
            planId: plan.id,
            ...(error instanceof RecoveryLineageError ? {
              assessmentId: error.assessmentId, storyKeys: error.storyKeys,
              originIssueNumbers: error.originIssueNumbers,
            } : { classification: 'assessment-contract' }),
            reason: error.message,
          }, `${key}:rejected`);
          result = { action: 'recovery-blocked', planId: plan.id, detail: error.message };
        }
        // A checks-pending deferral or its over-an-hour escalation must not
        // consume the quarantine or its reassessment request; leave it
        // unprocessed so a later completed check run can retry. Other
        // recovery-blocked outcomes (lineage/contract) stay consumed.
        if (result.action !== 'checks-pending' && result.cause !== 'pending-checks-escalation') {
          this.store.recordEvent('program.quarantine_processed', quarantine.id, { planId: plan.id, result: result.action }, key);
        }
        return result;
      }
    }

    if (plan.status === 'assessing') return this.finishWave(plan, signal);
    if (plan.status === 'active') {
      const verification = await this.verifyWaitingOperations(plan, signal);
      if (verification) return verification;
    }
    if (plan.status === 'delivered') {
      if (!this.config.program.maintenance) return { action: 'delivered', planId: plan.id };
      await this.coordinator.updateProgramState(plan.id, 'maintaining', { maintenanceStartedAt: plan.maintenanceStartedAt ?? Date.now() });
      return { action: 'maintaining', planId: plan.id };
    }
    if (plan.status === 'maintaining') {
      const accepted = this.store.listSignals().find((candidate) =>
        candidate.status === 'accepted' && !this.store.hasIdempotencyKey(`program:signal:${plan.id}:${candidate.id}`),
      );
      if (accepted) {
        if (plan.revisions?.some((revision) => revision.sourceSignalId === accepted.id)) {
          this.store.recordEvent('program.signal_processed', null, { planId: plan.id, signalId: accepted.id, recovered: true }, `program:signal:${plan.id}:${accepted.id}`);
          return { action: 'maintaining', planId: plan.id };
        }
        this.store.recordEvent('program.reassessment_requested', null, { planId: plan.id, signalId: accepted.id });
        const result = await this.reassess(plan, 'signal', signal, accepted.material, undefined, accepted.id);
        // A checks-pending deferral or its over-an-hour escalation must not
        // consume the accepted signal; leave it unprocessed so the next tick
        // retries the reassessment. Other recovery-blocked outcomes stay
        // consumed.
        if (result.action !== 'checks-pending' && result.cause !== 'pending-checks-escalation') {
          this.store.recordEvent('program.signal_processed', null, { planId: plan.id, signalId: accepted.id, result: result.action }, `program:signal:${plan.id}:${accepted.id}`);
        }
        return result;
      }
      return { action: 'maintaining', planId: plan.id };
    }
    return { action: 'idle', planId: plan.id };
  }

  async scanSignals(force = true) {
    const result = await this.signals.scan(force);
    this.store.recordEvent('evolution.scan_completed', null, result);
    return result;
  }

  decideSignal(id: string, accepted: boolean) {
    return this.signals.decide(id, accepted);
  }

  async reassess(
    plan: PortfolioPlan,
    reason: ProgramRevision['reason'] = 'manual',
    signal?: AbortSignal,
    approvedMaterialSignal = false,
    repositorySha?: string,
    sourceSignalId?: string,
  ): Promise<ProgramTickResult> {
    signal?.throwIfAborted();
    if (plan.status === 'awaiting_material_approval') {
      throw new Error('Resolve the pending material revision before reassessing; its proposed decisions are not approved');
    }
    const document = frozenRequirements(this.config.project.root, plan);
    const targetCommitSha = repositorySha ?? await this.remoteHead(signal);
    const deployment = plan.latestDeploymentId ? this.store.getDeployment(plan.latestDeploymentId) : null;
    const checks = await this.github.checksForRef(targetCommitSha, [...REQUIRED_POST_MERGE_GITHUB_CHECKS]);
    signal?.throwIfAborted();
    if (!checks.complete) {
      // Transient: the exact-commit verification evidence does not exist yet. Defer to the next supervisor tick
      // instead of polling here or persisting an assessment/revision built without it. This returns a
      // nonthrowing result (never a throw) so the daemon loop still records it and runs its self-hosting tick.
      // Zero assessment/revision mutations occur and the exact commit binding is preserved in the event key.
      return this.deferForPendingChecks(plan, targetCommitSha, checks.pending);
    }
    const checkEvidence = checks.complete && checks.successful
      ? this.config.gates.filter((gate) => gate.required).map((gate) => ({
          kind: 'test' as const,
          locator: gate.id,
          summary: `Required exact-commit checks passed for ${targetCommitSha}`,
          commitSha: targetCommitSha,
        }))
      : [];
    const deploymentEvidence = deployment?.status === 'succeeded' && deployment.commitSha === targetCommitSha
      ? [{
          kind: 'deployment' as const,
          locator: deployment.id,
          summary: `Staging health and lifecycle verification passed for ${deployment.commitSha}`,
          commitSha: deployment.commitSha,
        }]
      : [];
    const operationalEvidence = [...checkEvidence, ...deploymentEvidence];
    // Durable operator coverage challenges: an accepted product constraint can
    // contradict the model's implemented classification. Unresolved
    // challenges deterministically hold their coverage partial/implement until
    // a NEW approved unsuperseded implement story from a revision later than
    // the challenge's recorded plan revision completes with a persisted
    // passing exact-merge post-merge verification. Global gates, model
    // evidence, and pre-challenge completed stories never clear the hold.
    const unresolvedChallenges = await this.unresolvedCoverageChallenges(plan, targetCommitSha, signal);
    signal?.throwIfAborted();
    const challengedCoverageIds = new Set(unresolvedChallenges.map((challenge) => challenge.coverageId));
    // Bounded structured summary for the assessor; challenge content is
    // untrusted evidence for classification, never acceptance authority.
    const challengeFeedback = unresolvedChallenges.length
      ? JSON.stringify(unresolvedChallenges.map((challenge) => ({
          coverageId: challenge.coverageId,
          reason: challenge.reason.slice(0, 500),
          evidenceCommitSha: challenge.commitSha,
          evidenceFiles: challenge.files.slice(0, 5),
          planRevision: challenge.planRevision,
        })))
      : undefined;
    // Challenged prior coverage stays in snapshot focus even when the frozen
    // plan coverage still says implemented; the clone changes only the status
    // handed to the assessor, never the frozen id or requirement.
    const priorCoverage = (plan.coverage ?? []).map((entry) =>
      challengedCoverageIds.has(entry.id) ? { ...entry, status: 'partial' as const } : entry);
    const assessment = await this.assessor.assess(document, signal, operationalEvidence, targetCommitSha, challengeFeedback, priorCoverage);
    signal?.throwIfAborted();
    // Guard: an approved, unsuperseded verify story with an issued task that
    // has not finished is the standing acceptance contract for its coverage.
    // Model/global check evidence must not classify that coverage
    // implemented while the contracted verification task is still pending.
    // Failed and quarantined tasks keep this acceptance contract: they must
    // still block a false implemented/accepted classification.
    const pendingVerify = this.verifyAcceptanceContracts(plan);
    for (const entry of assessment.coverage) {
      const contract = pendingVerify.get(entry.id);
      if (!contract || entry.status !== 'implemented') continue;
      entry.status = 'unverified';
      entry.requiredAction = 'verify';
      entry.rationale = `Implemented claim from repository checks is held unverified pending accepted verification task #${contract.story.normalizedIssueNumber} (story ${contract.story.key}); no accepted verification or merge has completed that contract`;
    }
    // Deterministic challenge hold: overrides whatever the model or global
    // evidence claimed for the challenged coverage.
    for (const entry of assessment.coverage) {
      const challenge = unresolvedChallenges.find((candidate) => candidate.coverageId === entry.id);
      if (!challenge) continue;
      entry.status = 'partial';
      entry.requiredAction = 'implement';
      entry.rationale = `Operator coverage challenge ${challenge.authorizationId} holds this coverage partial: the accepted constraint "${challenge.reason.slice(0, 200)}" is not satisfied by current evidence; only a new approved implement story from a revision later than ${challenge.planRevision} with an exact-merge passing post-merge verification can restore it`;
    }
    // Deterministic requirement-proof binding: an implemented coverage entry is
    // only accepted when a harness-tracked story/task chain explicitly covers
    // that requirement — an approved unsuperseded implement/verify story, an
    // ingested done task, a merge commit that is an ancestor of the assessed
    // commit, and a persisted passing post-merge verification for that exact
    // merge. Global gates, model-cited source/test files, signals, and global
    // staging deployments are not requirement-specific and never bind proof.
    // Preserve accepted, requirement-specific proof across routine and manual
    // reassessment when the model supplies only generic uncertainty. The
    // historical approved assessment must name the exact same requirement.
    await this.retainProvenCoverage(plan, assessment, {
      reason,
      checksSuccessful: checks.complete && checks.successful,
      materialSignal: approvedMaterialSignal || sourceSignalId !== undefined,
      challengedCoverageIds,
      pendingVerify,
      deployment,
    }, signal);
    await this.bindImplementationProofs(plan, assessment, signal);
    this.store.saveRepositoryAssessment(assessment);
    await this.recordExternalCommits(plan, assessment.commitSha, signal);
    signal?.throwIfAborted();
    const auditComplete = checks.complete && checks.successful &&
      assessment.coverage.length > 0 && assessment.coverage.every((entry) => entry.status === 'implemented');
    if (auditComplete) {
      const now = Date.now();
      const delivered = await this.coordinator.updateProgramState(plan.id, 'delivered', {
        assessmentId: assessment.id,
        repositorySha: assessment.commitSha,
        coverage: assessment.coverage,
        deliveredAt: plan.deliveredAt ?? now,
      });
      this.store.recordEvent('program.objective_accepted', null, {
        planId: plan.id,
        assessmentId: assessment.id,
        repositorySha: assessment.commitSha,
      }, `program:accepted:${plan.id}:${assessment.commitSha}`);
      if (this.config.program.maintenance) {
        await this.coordinator.updateProgramState(delivered.id, 'maintaining', { maintenanceStartedAt: now });
        return { action: 'maintaining', planId: plan.id };
      }
      return { action: 'delivered', planId: plan.id };
    }
    const actionable = assessment.coverage.some((entry) => ['partial', 'missing', 'unverified'].includes(entry.status));
    if (!actionable) {
      await this.coordinator.updateProgramState(plan.id, 'blocked', {
        assessmentId: assessment.id,
        repositorySha: assessment.commitSha,
        coverage: assessment.coverage,
      });
      return { action: 'reassessed', planId: plan.id, detail: 'Objective is externally blocked' };
    }
    signal?.throwIfAborted();
    // Planning suppression is narrower than acceptance: only actively
    // pending tasks (ready/active/waiting and other in-flight states)
    // suppress duplicate verification stories. Failed/quarantined tasks do
    // not — the planner may propose an approved-scope replacement repair
    // story with preserved lineage for their coverage.
    const planningVerify = this.pendingVerifyContracts(plan);
    const pendingChallengedImplement = this.pendingChallengedImplementContracts(plan, unresolvedChallenges);
    const planningAssessment = await this.planningOnlyAssessment(plan, assessment, checks, signal, planningVerify, pendingChallengedImplement);
    signal?.throwIfAborted();
    if (!planningAssessment.coverage.some((entry) => entry.requiredAction !== 'none')) {
      // Guard: when the only actionable work is already assigned to pending
      // approved verification tasks, do not create a revision (the planner
      // would only invent a duplicate verify story or a falsely delivered
      // result). Retain the active/blocked program state with the updated
      // coverage and leave the pending task contracts intact.
      const heldByPendingTasks = [...planningVerify.keys()].some((id) =>
        planningAssessment.coverage.some((entry) => entry.id === id && entry.status === 'unverified')) ||
        [...pendingChallengedImplement.keys()].some((id) =>
          planningAssessment.coverage.some((entry) => entry.id === id && entry.status === 'partial'));
      const retainedStatus = heldByPendingTasks && ['active', 'blocked'].includes(plan.status) ? plan.status : 'blocked';
      await this.coordinator.updateProgramState(plan.id, retainedStatus, {
        assessmentId: assessment.id,
        repositorySha: assessment.commitSha,
        coverage: assessment.coverage,
      });
      return {
        action: 'reassessed',
        planId: plan.id,
        detail: heldByPendingTasks
          ? 'Remaining verification work is already assigned to pending accepted tasks; no duplicate verification story planned'
          : 'Objective has no plannable work after completed verification and blocker documentation',
      };
    }
    const draft = await this.planner.plan(document, undefined, planningAssessment, undefined, {
      technologyDecisions: structuredClone(plan.technologyDecisions),
      deploymentDecisions: structuredClone(plan.deploymentDecisions),
      constraints: [...plan.constraints],
      definitionOfDone: [...plan.definitionOfDone],
    }, {
      signal,
      onProgress: (progress) => {
        const payload = { planId: plan.id, revision: plan.revision ?? 1, assessmentId: assessment.id, ...progress };
        this.store.recordEvent('program.planning_progress', null, payload);
        this.logger?.info('program planning progress', payload);
      },
    });
    signal?.throwIfAborted();
    const material = materialRevision(plan, draft);
    if (!material) preserveDecisionIdentities(plan, draft);
    const revised = await this.coordinator.revise({
      planId: plan.id,
      draft,
      assessment,
      reason,
      material,
      approvedMaterial: material && approvedMaterialSignal,
      sourceSignalId,
      summary: `Repository reassessment after ${reason}`,
    });
    return {
      action: material && !approvedMaterialSignal ? 'awaiting-material-approval' : 'reassessed',
      planId: revised.id,
      detail: `revision ${revised.revision ?? 1}`,
    };
  }

  /**
   * Nonthrowing deferral for incomplete required exact-commit checks. Records
   * a deduplicated pending-check event keyed by plan + commit + pending
   * checks for visibility, mutates no assessment/revision/program state, and
   * never weakens the required checks. If the same required checks have
   * stayed incomplete for more than an hour after their first observation,
   * returns recovery-blocked with a deduplicated escalation event.
   */
  private deferForPendingChecks(
    plan: PortfolioPlan,
    commitSha: string,
    pending: string[],
  ): ProgramTickResult {
    const normalized = [...new Set(pending)].sort();
    const pendingToken = normalized.join('|') || 'unknown';
    const detail = `Required exact-commit checks for ${commitSha} are incomplete (pending: ${normalized.join(', ') || 'unknown'}); reassessment deferred to the next supervisor tick`;
    const key = `program:checks-pending:${plan.id}:${commitSha}:${pendingToken}`;
    if (!this.store.hasIdempotencyKey(key)) {
      this.store.recordEvent('program.reassessment_checks_pending', null, {
        planId: plan.id,
        commitSha,
        pending: normalized,
      }, key);
    }
    const expected = JSON.stringify(normalized);
    const firstObservedAt = this.store.listEvents('program.reassessment_checks_pending')
      .filter((event) =>
        event.payload.planId === plan.id &&
        event.payload.commitSha === commitSha &&
        JSON.stringify(event.payload.pending ?? []) === expected)
      .reduce((earliest, event) => Math.min(earliest, event.createdAt), Number.POSITIVE_INFINITY);
    if (Number.isFinite(firstObservedAt) && Date.now() - firstObservedAt > PENDING_CHECKS_ESCALATION_MS) {
      const escalationKey = `program:checks-pending-escalated:${plan.id}:${commitSha}:${pendingToken}`;
      if (!this.store.hasIdempotencyKey(escalationKey)) {
        this.store.recordEvent('program.reassessment_checks_escalated', null, {
          planId: plan.id,
          commitSha,
          pending: normalized,
          firstObservedAt,
        }, escalationKey);
      }
      return {
        action: 'recovery-blocked',
        planId: plan.id,
        detail: `Required exact-commit checks have been pending for over an hour for ${commitSha} (pending: ${normalized.join(', ') || 'unknown'}); recovery stays blocked until the required checks complete`,
        cause: 'pending-checks-escalation',
      };
    }
    return { action: 'checks-pending', planId: plan.id, detail };
  }

  private async planningOnlyAssessment(
    plan: PortfolioPlan,
    assessment: RepositoryAssessment,
    checks: CheckSummary,
    signal?: AbortSignal,
    pendingVerify: Map<string, { story: PortfolioStory; task: TaskRecord | null }> = new Map(),
    pendingChallengedImplement: Map<string, { story: PortfolioStory; task: TaskRecord | null }> = new Map(),
  ): Promise<RepositoryAssessment> {
    const coverage: ObjectiveCoverage[] = structuredClone(assessment.coverage);
    const verifiedChecks = checks.complete && checks.successful && checks.failed.length === 0;
    const doneStories = (entryId: string, workType: ProgramWorkType) => plan.stories.filter((story) =>
      !story.supersededAt && story.workType === workType && story.coverageIds?.includes(entryId) &&
      story.normalizedIssueNumber !== null && this.store.findByIssue(story.normalizedIssueNumber)?.state === 'done');
    for (const entry of coverage) {
      if (entry.status === 'externally_blocked') {
        const citedFiles = entry.evidence.filter((item) => item.kind === 'file' && assessment.files.includes(item.locator));
        let blockerDocumentExists = false;
        for (const story of doneStories(entry.id, 'document')) {
          const task = this.store.findByIssue(story.normalizedIssueNumber as number);
          if (!task || !isCommitSha(task.baseSha) || !isCommitSha(task.commitSha)) continue;
          const documentDiff = await runProcess({
            command: 'git',
            args: ['diff', '--name-only', `${task.baseSha}..${task.commitSha}`],
            cwd: this.config.project.root,
            timeoutMs: 30_000,
            signal,
          });
          // Any unknown git result keeps the external requirement.
          if (documentDiff.exitCode !== 0) continue;
          const changedByDocumentTask = new Set(documentDiff.stdout.split('\n').map((value) => value.trim()).filter(Boolean));
          for (const item of citedFiles) {
            if (!changedByDocumentTask.has(item.locator)) continue;
            if (await safeCommitFileExists(this.config.project.root, assessment.commitSha, item.locator, signal)) blockerDocumentExists = true;
            if (blockerDocumentExists) break;
          }
          if (blockerDocumentExists) break;
        }
        if (blockerDocumentExists) entry.requiredAction = 'none';
        continue;
      }
      if (entry.status !== 'unverified' || entry.requiredAction !== 'verify' || !verifiedChecks) continue;
      const mergeSha = doneStories(entry.id, 'verify')
        .map((story) => this.store.findByIssue(story.normalizedIssueNumber as number)?.mergeSha)
        .find((sha): sha is string => /^[0-9a-f]{40}$/i.test(sha ?? ''));
      if (!mergeSha) continue;
      const diff = await runProcess({
        command: 'git',
        args: ['diff', '--name-only', `${mergeSha}..${assessment.commitSha}`],
        cwd: this.config.project.root,
        timeoutMs: 30_000,
        signal,
      });
      // Any unknown git result keeps the verification requirement.
      if (diff.exitCode !== 0) continue;
      const changed = diff.stdout.split('\n').map((value) => value.trim()).filter(Boolean);
      if (changed.every((file) => file.startsWith('docs/'))) entry.requiredAction = 'none';
    }
    // Guard: verification already assigned to an approved pending task must
    // not be planned again; the planner would duplicate the story.
    for (const entry of coverage) {
      if (entry.requiredAction === 'verify' && pendingVerify.has(entry.id)) entry.requiredAction = 'none';
    }
    // Guard: challenged implementation already assigned to an approved
    // pending implement story from a later revision must not be planned
    // again; the persisted coverage stays partial until that story resolves.
    for (const entry of coverage) {
      if (entry.requiredAction === 'implement' && pendingChallengedImplement.has(entry.id)) entry.requiredAction = 'none';
    }
    return { ...assessment, coverage };
  }

  /**
   * Coverage IDs mapped to approved, unsuperseded verify stories whose issued
   * task has not finished. These are standing acceptance contracts:
   * their coverage may not be classified implemented from model/global checks.
   * Publication can precede intake, so stories whose normalized issue has not
   * been ingested as a local task still hold the contract. Failed,
   * quarantined, and cancelled tasks are included so they still prevent a
   * false implemented/accepted classification until the story is superseded
   * or a completed verification is accepted.
   */
  private verifyAcceptanceContracts(plan: PortfolioPlan): Map<string, { story: PortfolioStory; task: TaskRecord | null }> {
    return this.verifyContracts(plan, { includeFailed: true });
  }

  /**
   * Coverage IDs mapped to approved, unsuperseded verify stories whose issued
   * task is actively pending (not finished, failed, quarantined, or
   * cancelled), including stories whose normalized issue is published but not
   * yet ingested as a local task — duplicate verify planning stays suppressed
   * while the issue awaits ingestion. Failed/quarantined/cancelled tasks are
   * excluded: their coverage is plannable so an approved-scope replacement
   * repair story with preserved lineage can be proposed.
   */
  private pendingVerifyContracts(plan: PortfolioPlan): Map<string, { story: PortfolioStory; task: TaskRecord | null }> {
    return this.verifyContracts(plan, { includeFailed: false });
  }

  private verifyContracts(plan: PortfolioPlan, options: { includeFailed: boolean }): Map<string, { story: PortfolioStory; task: TaskRecord | null }> {
    const pending = new Map<string, { story: PortfolioStory; task: TaskRecord | null }>();
    if (plan.approvedAt === null) return pending;
    for (const story of plan.stories) {
      if (story.supersededAt || story.workType !== 'verify' || story.normalizedIssueNumber === null) continue;
      const task = this.store.findByIssue(story.normalizedIssueNumber) ?? null;
      if (task?.state === 'done') continue;
      if (task && !options.includeFailed && ['failed', 'quarantined', 'cancelled'].includes(task.state)) continue;
      for (const id of story.coverageIds ?? []) {
        if (!pending.has(id)) pending.set(id, { story, task });
      }
    }
    return pending;
  }

  /** Durable operator coverage challenge projected from persisted events. */
  private coverageChallenges(plan: PortfolioPlan): CoverageChallenge[] {
    return this.store.listEvents('program.coverage_challenged')
      .filter((event) => event.payload.planId === plan.id)
      .map((event) => ({
        coverageId: String(event.payload.coverageId ?? ''),
        reason: String(event.payload.reason ?? ''),
        commitSha: String(event.payload.commitSha ?? ''),
        files: Array.isArray(event.payload.files) ? event.payload.files.map(String) : [],
        authorizationId: String(event.payload.authorizationId ?? ''),
        authorizedBy: String(event.payload.authorizedBy ?? ''),
        planRevision: Number(event.payload.planRevision ?? 1),
        createdAt: event.createdAt,
      }));
  }

  private async unresolvedCoverageChallenges(plan: PortfolioPlan, commitSha: string, signal?: AbortSignal): Promise<CoverageChallenge[]> {
    const unresolved: CoverageChallenge[] = [];
    for (const challenge of this.coverageChallenges(plan)) {
      if (!await this.challengeResolutionProof(plan, challenge, commitSha, signal)) unresolved.push(challenge);
    }
    return unresolved;
  }

  /** A challenge clears only for a NEW approved unsuperseded implement story
   * from a revision strictly later than the challenged plan revision whose
   * issued task is done, whose merge is an ancestor of the assessed commit,
   * and with a persisted passing exact-merge post-merge verification.
   * Pre-challenge stories, global gates, and model evidence never resolve it. */
  private async challengeResolutionProof(plan: PortfolioPlan, challenge: CoverageChallenge, commitSha: string, signal?: AbortSignal): Promise<boolean> {
    if (plan.approvedAt === null) return false;
    const postmergeEvents = this.store.listEvents('postmerge.verification');
    for (const story of plan.stories) {
      if (story.supersededAt || story.workType !== 'implement' || story.normalizedIssueNumber === null) continue;
      if (!story.coverageIds?.includes(challenge.coverageId)) continue;
      if ((story.revision ?? 0) <= challenge.planRevision) continue;
      const task = this.store.findByIssue(story.normalizedIssueNumber);
      if (!task || task.state !== 'done' || !isCommitSha(task.mergeSha)) continue;
      if (!await safeMergeAncestor(this.config.project.root, task.mergeSha, commitSha, signal)) continue;
      if (postmergeEvents.some((event) => event.taskId === task.id && event.payload.mergeSha === task.mergeSha && event.payload.passed === true)) return true;
    }
    return false;
  }

  /** Challenged coverage mapped to an approved unsuperseded implement story
   * from a revision later than its challenge whose work is actively pending —
   * either an issued task that has not finished or a story whose issue has
   * not yet been normalized. Duplicate implement planning is suppressed for
   * that coverage while the persisted coverage stays partial.
   * Failed/quarantined/cancelled tasks are excluded so a replacement
   * implement story can still be planned. */
  private pendingChallengedImplementContracts(plan: PortfolioPlan, unresolved: CoverageChallenge[]): Map<string, { story: PortfolioStory; task: TaskRecord | null }> {
    const pending = new Map<string, { story: PortfolioStory; task: TaskRecord | null }>();
    if (plan.approvedAt === null) return pending;
    for (const story of plan.stories) {
      if (story.supersededAt || story.workType !== 'implement') continue;
      const task = story.normalizedIssueNumber === null ? null : this.store.findByIssue(story.normalizedIssueNumber) ?? null;
      if (task?.state === 'done') continue;
      if (task && ['failed', 'quarantined', 'cancelled'].includes(task.state)) continue;
      for (const id of story.coverageIds ?? []) {
        const challenge = unresolved.find((candidate) => candidate.coverageId === id);
        if (!challenge || (story.revision ?? 0) <= challenge.planRevision) continue;
        if (!pending.has(id)) pending.set(id, { story, task });
      }
    }
    return pending;
  }

  /**
   * Holds every implemented coverage entry without a deterministic
   * requirement-specific proof at unverified/verify, and appends the
   * controller's own story/task evidence reference to proven coverage.
   * Model-selected evidence locators are never trusted as the binding.
   */
  private async bindImplementationProofs(plan: PortfolioPlan, assessment: RepositoryAssessment, signal?: AbortSignal): Promise<void> {
    for (const entry of assessment.coverage) {
      if (entry.status !== 'implemented') continue;
      const proof = await this.requirementProof(plan, entry.id, assessment.commitSha, signal);
      signal?.throwIfAborted();
      if (proof) {
        const locator = `story:${proof.story.key}:task:${proof.task.issueNumber}:${proof.mergeSha}`;
        if (!entry.evidence.some((item) => item.kind === 'git' && item.locator === locator)) {
          entry.evidence.push({
            kind: 'git',
            locator,
            summary: proof.via === 'read-only'
              ? `Story ${proof.story.key} (issue #${proof.task.issueNumber}) verified read-only at ${proof.mergeSha} with passing exact-commit checks and independent scorecard`
              : `Story ${proof.story.key} (issue #${proof.task.issueNumber}) merged at ${proof.mergeSha} with passing exact-merge post-merge verification`,
            commitSha: assessment.commitSha,
          });
        }
        continue;
      }
      entry.status = 'unverified';
      entry.requiredAction = 'verify';
      entry.rationale = `Implemented claim is held unverified: no approved unsuperseded implement/verify story with a done task, a verified commit ancestor of ${assessment.commitSha}, and a passing exact-merge post-merge verification (or trusted read-only verification for verify stories) explicitly covers ${entry.id}; global checks, model-cited files, signals, and deployments are not requirement-specific proof`;
    }
  }

  /** Retention of previously accepted coverage. See the
   * call site for the full gate list; any doubt (failing checks, signal or
   * quarantine context, unresolved challenge, pending verification contract,
   * failed staging, no matching approved coverage, or no current
   * deterministic proof) leaves the model's classification untouched. */
  private async retainProvenCoverage(
    plan: PortfolioPlan,
    assessment: RepositoryAssessment,
    context: {
      reason: ProgramRevision['reason'];
      checksSuccessful: boolean;
      materialSignal: boolean;
      challengedCoverageIds: Set<string>;
      pendingVerify: Map<string, { story: PortfolioStory; task: TaskRecord | null }>;
      deployment: { status: string } | null;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    if (!['wave-complete', 'manual'].includes(context.reason) || !context.checksSuccessful || context.materialSignal) return;
    if (context.deployment && ['failed', 'rolled_back'].includes(context.deployment.status)) return;
    for (const entry of assessment.coverage) {
      if (entry.status !== 'partial') continue;
      if (context.challengedCoverageIds.has(entry.id) || context.pendingVerify.has(entry.id)) continue;
      if (!isGenericProofUncertainty(entry)) continue;
      // Walk backwards through approved assessments. A later concrete gap or
      // changed requirement prevents an older implementation proof from
      // silently overriding it; a later generic downgrade may be recovered.
      let accepted = false;
      for (const revision of [...(plan.revisions ?? [])].reverse()) {
        if (revision.approvedAt === null || revision.rejectedAt) continue;
        const prior = this.store.getRepositoryAssessment(revision.assessmentId)?.coverage.find((candidate) => candidate.id === entry.id);
        if (!prior) { if (revision.material) break; else continue; }
        if (prior.requirement !== entry.requirement) break;
        if (prior.status === 'implemented') { accepted = true; break; }
        if (revision.material || prior.status !== 'partial' || !isGenericProofUncertainty(prior)) break;
      }
      if (!accepted) continue;
      const proof = await this.requirementProof(plan, entry.id, assessment.commitSha, signal);
      signal?.throwIfAborted();
      if (!proof) continue;
      entry.status = 'implemented';
      entry.requiredAction = 'none';
      entry.rationale = `Retained implemented from prior accepted coverage: the reassessment cited only generic uncertainty, while story ${proof.story.key} (issue #${proof.task.issueNumber}) still proves this requirement at ${assessment.commitSha} via ${proof.via === 'read-only' ? 'a trusted read-only verification' : 'a passing exact-merge post-merge verification'}; no duplicate story is needed`;
      this.store.recordEvent('program.coverage_retained', null, {
        planId: plan.id,
        coverageId: entry.id,
        commitSha: assessment.commitSha,
        storyKey: proof.story.key,
        issueNumber: proof.task.issueNumber,
        mergeSha: proof.mergeSha,
      }, `program:coverage-retained:${plan.id}:${entry.id}:${assessment.commitSha}`);
    }
  }

  /** First deterministic story/task/merge proof chain that explicitly covers
   * the coverage ID, or null when none holds. Implementation stories (and
   * verify stories that merged) prove out via a passing exact-merge
   * post-merge verification event. A read-only verify story never merges:
   * its supervisor completion (exact-commit GitHub checks, independent
   * scorecard, remote-head/worktree verification, then a
   * task.read_only_verified event and a done task whose mergeSha is the
   * verified commit) is the trusted equivalent — accepted only when the
   * event's taskId and commitSha match the done task, its scorecardId
   * resolves to the persisted passing scorecard for that exact task and
   * commit, and the verified commit is an ancestor of the assessed commit. */
  private async requirementProof(plan: PortfolioPlan, entryId: string, commitSha: string, signal?: AbortSignal): Promise<{ story: PortfolioStory; task: TaskRecord; mergeSha: string; via: 'postmerge' | 'read-only' } | null> {
    if (plan.approvedAt === null) return null;
    const postmergeEvents = this.store.listEvents('postmerge.verification');
    const readOnlyEvents = this.store.listEvents('task.read_only_verified');
    for (const story of plan.stories) {
      if (story.supersededAt || !(story.workType === 'implement' || story.workType === 'verify')) continue;
      if (!story.coverageIds?.includes(entryId) || story.normalizedIssueNumber === null) continue;
      const task = this.store.findByIssue(story.normalizedIssueNumber);
      if (!task || task.state !== 'done' || !isCommitSha(task.mergeSha)) continue;
      const mergeSha = task.mergeSha;
      // An unknown git result conservatively keeps the requirement unverified.
      if (!await safeMergeAncestor(this.config.project.root, mergeSha, commitSha, signal)) continue;
      if (postmergeEvents.some((event) => event.taskId === task.id && event.payload.mergeSha === mergeSha && event.payload.passed === true)) {
        return { story, task, mergeSha, via: 'postmerge' };
      }
      if (story.workType === 'verify' && readOnlyEvents.some((event) =>
        event.taskId === task.id &&
        event.payload.commitSha === mergeSha &&
        typeof event.payload.scorecardId === 'string' &&
        isCommitSha(event.payload.commitSha) &&
        (() => {
          const scorecard = this.store.getScorecard(event.payload.scorecardId);
          return scorecard !== null && scorecard.taskId === task.id &&
            scorecard.commitSha === mergeSha && scorecard.passed === true;
        })())) {
        return { story, task, mergeSha, via: 'read-only' };
      }
    }
    return null;
  }

  private async finishWave(plan: PortfolioPlan, signal?: AbortSignal): Promise<ProgramTickResult> {
    const commitSha = await this.remoteHead(signal);
    if (this.config.deployment.staging.enabled) {
      const existing = this.store.listDeployments(plan.id).find((record) => record.wave === (plan.currentWave ?? 1) && record.commitSha === commitSha);
      if (existing?.status === 'failed' || existing?.status === 'rolled_back') {
        await this.ensureStagingRepair(plan, existing.error ?? 'Staging verification failed', commitSha);
        return { action: 'deployment-failed', planId: plan.id, detail: existing.id };
      }
      const deployment = existing?.status === 'succeeded'
        ? existing
        : await this.deployer.deploy({ planId: plan.id, wave: plan.currentWave ?? 1, commitSha, signal });
      await this.coordinator.updateProgramState(plan.id, 'assessing', {
        latestDeploymentId: deployment.id,
        repositorySha: commitSha,
      });
      if (deployment.status !== 'succeeded') {
        await this.ensureStagingRepair(plan, deployment.error ?? 'Staging verification failed', commitSha);
        return { action: 'deployment-failed', planId: plan.id, detail: deployment.id };
      }
    }
    const updated = this.store.getPortfolioPlan(plan.id) as PortfolioPlan;
    const result = await this.reassess(updated, 'wave-complete', signal, false, commitSha);
    return result.action === 'reassessed' ? { ...result, action: 'deployed' } : result;
  }

  private async verifyWaitingOperations(plan: PortfolioPlan, signal?: AbortSignal): Promise<ProgramTickResult | null> {
    if (!this.config.deployment.staging.enabled || plan.approvedAt === null) return null;
    const wave = plan.stories.filter((story) => !story.supersededAt && (story.wave ?? 1) === (plan.currentWave ?? 1));
    const pending = wave.filter((story) => this.store.findByIssue(story.normalizedIssueNumber ?? -1)?.state !== 'done');
    if (!pending.length || pending.some((story) => story.workType !== 'operate')) return null;
    const commitSha = await this.remoteHead(signal);
    const waiting = [...this.store.listEvents('task.verification_wait'), ...this.store.listEvents('task.staging_preparation_requested')];
    for (const story of pending) {
      const task = this.store.findByIssue(story.normalizedIssueNumber ?? -1);
      if (!task || task.state !== 'waiting' || task.waitKind !== 'provider' || task.prNumber !== null ||
          !task.spec || !matchesPortfolioTaskContract(plan, story, task.spec) ||
          task.commitSha !== commitSha || task.baseSha !== commitSha || !waiting.some((event) =>
            event.taskId === task.id && event.payload.commitSha === commitSha)) return null;
    }
    const checks = await this.github.checksForRef(commitSha, [...REQUIRED_POST_MERGE_GITHUB_CHECKS]);
    if (!checks.complete || !checks.successful || checks.failed.length || await this.remoteHead(signal) !== commitSha) return null;
    const deployment = this.store.listDeployments(plan.id).find((record) => record.wave === (plan.currentWave ?? 1) && record.commitSha === commitSha);
    if (deployment?.status === 'failed' || deployment?.status === 'rolled_back') {
      await this.ensureStagingRepair(plan, deployment.error ?? 'Staging verification failed', commitSha);
      return { action: 'deployment-failed', planId: plan.id, detail: deployment.id };
    }
    const verified = deployment?.status === 'succeeded' ? deployment
      : await this.deployer.deploy({ planId: plan.id, wave: plan.currentWave ?? 1, commitSha, signal });
    await this.coordinator.updateProgramState(plan.id, 'active', { latestDeploymentId: verified.id });
    if (verified.status !== 'succeeded') {
      await this.ensureStagingRepair(plan, verified.error ?? 'Staging verification failed', commitSha);
      return { action: 'deployment-failed', planId: plan.id, detail: verified.id };
    }
    // Preserve task contracts and their waiting state. Only the supervisor can complete their acceptance checks.
    return { action: 'deployed', planId: plan.id, detail: verified.id };
  }

  private async ensureStagingRepair(plan: PortfolioPlan, error: string, commitSha: string): Promise<void> {
    const key = `staging-repair:${plan.id}:${plan.currentWave ?? 1}:${commitSha}`;
    if (this.store.hasIdempotencyKey(key)) return;
    const title = `[self-repair] Staging regression at ${commitSha.slice(0, 12)}`;
    const existing = (await this.github.listOpenIssues()).find((issue) => issue.title === title && issue.labels.includes('self-repair'));
    const issue = existing ?? await this.github.createIssue({
      title,
      body: [
        `Staging verification failed for program ${plan.id}, wave ${plan.currentWave ?? 1}.`,
        `Commit: ${commitSha}`,
        '',
        'Failure evidence:',
        '```text',
        error.slice(0, 4_000),
        '```',
      ].join('\n'),
      labels: ['self-repair', this.config.intake.approvalLabel],
    });
    this.store.recordEvent(existing ? 'staging.repair_reused' : 'staging.repair_created', null, { planId: plan.id, issueNumber: issue.number, commitSha }, key);
  }

  private quarantinedWaveTask(plan: PortfolioPlan) {
    return this.failedWaveTasks(plan).find((task) => task.state === 'quarantined');
  }

  private failedWaveTasks(plan: PortfolioPlan) {
    const issueNumbers = new Set(plan.stories
      .filter((story) => !story.supersededAt && (story.wave ?? 1) === (plan.currentWave ?? 1))
      .flatMap((story) => story.normalizedIssueNumber === null ? [] : [story.normalizedIssueNumber]));
    return this.store.list(['failed', 'quarantined']).filter((task) => issueNumbers.has(task.issueNumber));
  }

  private async reconcileDeployments(signal?: AbortSignal): Promise<void> {
    for (const record of this.store.listDeployments().filter((candidate) => !['succeeded', 'failed', 'rolled_back'].includes(candidate.status))) {
      await this.deployer.reconcile(record, signal);
    }
  }

  private async scanSignalsIfDue(): Promise<void> {
    const latest = this.store.listEvents('evolution.scan_completed').at(-1);
    if (latest && Date.now() - latest.createdAt < this.config.evolution.pollIntervalMs) return;
    const result = await this.signals.scan();
    this.store.recordEvent('evolution.scan_completed', null, result);
  }

  private async remoteHead(signal?: AbortSignal): Promise<string> {
    const fetch = await runProcess({ command: 'git', args: ['fetch', '--quiet', 'origin', this.config.project.defaultBranch], cwd: this.config.project.root, timeoutMs: 2 * 60_000, signal });
    if (fetch.exitCode !== 0) throw new Error(`Could not refresh ${this.config.project.defaultBranch}: ${fetch.stderr}`);
    const ref = `refs/remotes/origin/${this.config.project.defaultBranch}`;
    const head = await runProcess({ command: 'git', args: ['rev-parse', ref], cwd: this.config.project.root, timeoutMs: 10_000, signal });
    if (head.exitCode !== 0 || !/^[0-9a-f]{40}$/i.test(head.stdout.trim())) throw new Error(`Could not resolve ${ref}`);
    return head.stdout.trim();
  }

  private async recordExternalCommits(plan: PortfolioPlan, currentSha: string, signal?: AbortSignal): Promise<void> {
    const previousSha = plan.repositorySha;
    if (!previousSha || previousSha === currentSha || !/^[0-9a-f]{40}$/i.test(previousSha)) return;
    const history = await runProcess({
      command: 'git',
      args: ['rev-list', '--reverse', `${previousSha}..${currentSha}`],
      cwd: this.config.project.root,
      timeoutMs: 30_000,
      signal,
    });
    if (history.exitCode !== 0) throw new Error(`Could not reconcile program commit history: ${history.stderr}`);
    const issueNumbers = new Set(plan.stories.flatMap((story) => story.normalizedIssueNumber === null ? [] : [story.normalizedIssueNumber]));
    const known = new Set(this.store.list()
      .filter((task) => issueNumbers.has(task.issueNumber))
      .flatMap((task) => [task.commitSha, task.mergeSha].filter((sha): sha is string => Boolean(sha))));
    for (const taskSha of [...known]) {
      const ancestors = await runProcess({
        command: 'git',
        args: ['rev-list', `${previousSha}..${taskSha}`],
        cwd: this.config.project.root,
        timeoutMs: 30_000,
        signal,
      });
      if (ancestors.exitCode === 0) {
        for (const commitSha of ancestors.stdout.split('\n').map((value) => value.trim()).filter(Boolean)) known.add(commitSha);
      }
    }
    for (const commitSha of history.stdout.split('\n').map((value) => value.trim()).filter(Boolean)) {
      if (known.has(commitSha)) continue;
      this.store.recordEvent('program.external_commit_observed', null, {
        planId: plan.id,
        commitSha,
        reason: 'Commit is not linked to a harness task in this approved program',
      }, `program:external-commit:${plan.id}:${commitSha}`);
    }
  }
}

function isCommitSha(sha: string | null): sha is string {
  return typeof sha === 'string' && /^[0-9a-f]{40}$/i.test(sha);
}

function isGenericProofUncertainty(entry: ObjectiveCoverage): boolean {
  const generic = /\bsupplied (?:detailed )?(?:content|detail|evidence) (?:does|do) not fully prove\b/i.test(entry.rationale);
  const concreteGap = /\b(?:missing|fails?|rejects?|contradicts?|unimplemented|not implemented|gap remains|cannot)\b/i.test(entry.rationale);
  const contraryEvidence = entry.evidence.some((item) =>
    /\b(?:missing|fails?|rejects?|absent|contradicts?|unimplemented)\b/i.test(item.summary));
  return generic && !concreteGap && !contraryEvidence;
}

async function safeMergeAncestor(root: string, mergeSha: string, commitSha: string, signal?: AbortSignal): Promise<boolean> {
  if (!isCommitSha(commitSha)) return false;
  const result = await runProcess({
    command: 'git',
    args: ['merge-base', '--is-ancestor', mergeSha, commitSha],
    cwd: root,
    timeoutMs: 30_000,
    signal,
  });
  // Any nonzero result (unrelated history or unknown git error) conservatively
  // rejects the merge as proof.
  return result.exitCode === 0;
}

async function safeCommitFileExists(root: string, commitSha: string, relative: string, signal?: AbortSignal): Promise<boolean> {
  if (!/^[0-9a-f]{40}$/i.test(commitSha)) return false;
  if (!relative || path.posix.isAbsolute(relative) || relative.split('/').includes('..') ||
      !/^[A-Za-z0-9._\-/]+$/.test(relative)) return false;
  const result = await runProcess({
    command: 'git',
    args: ['cat-file', '-e', `${commitSha}:${relative}`],
    cwd: root,
    timeoutMs: 30_000,
    signal,
  });
  // Any nonzero result (missing path or unknown git error) conservatively keeps the requirement.
  return result.exitCode === 0;
}

function frozenRequirements(root: string, plan: PortfolioPlan) {
  if (plan.sourceContent !== undefined) return { sourcePath: plan.sourcePath, content: plan.sourceContent };
  const document = readRequirementsDocument(root, plan.sourcePath);
  const currentHash = createHash('sha256').update(document.content).digest('hex');
  if (currentHash !== plan.contentHash) {
    throw new Error(`Approved objective ${plan.sourcePath} changed after approval; create and approve a material program revision instead`);
  }
  return document;
}

const technologyIdentity = ({ category, technology, source }: PortfolioPlan['technologyDecisions'][number]) => JSON.stringify([category, technology, source]);
const deploymentIdentity = ({ component, provider, environment, authority }: PortfolioPlan['deploymentDecisions'][number]) => JSON.stringify([component, provider, environment, authority]);

export function materialRevision(plan: PortfolioPlan, draft: Awaited<ReturnType<PortfolioPlanner['plan']>>): boolean {
  const canonical = <T>(items: T[], identity: (item: T) => string) => JSON.stringify(items.map(identity).sort());
  return canonical(plan.technologyDecisions, technologyIdentity) !== canonical(draft.technologyDecisions, technologyIdentity) ||
    canonical(plan.deploymentDecisions, deploymentIdentity) !== canonical(draft.deploymentDecisions, deploymentIdentity);
}

export function preserveDecisionIdentities(plan: PortfolioPlan, draft: Awaited<ReturnType<PortfolioPlanner['plan']>>): void {
  if (materialRevision(plan, draft)) throw new Error('Cannot preserve identities across material decision changes');
  const technologies = new Map(draft.technologyDecisions.map((decision) => [decision.id,
    plan.technologyDecisions.find((frozen) => technologyIdentity(frozen) === technologyIdentity(decision))!.id]));
  const deployments = new Map(draft.deploymentDecisions.map((decision) => [decision.id,
    plan.deploymentDecisions.find((frozen) => deploymentIdentity(frozen) === deploymentIdentity(decision))!.id]));
  for (const story of draft.stories) {
    story.technologyDecisionIds = story.technologyDecisionIds.map((id) => {
      const frozen = technologies.get(id);
      if (!frozen) throw new Error(`Unknown proposed technology decision ${id}`);
      return frozen;
    });
    story.deploymentDecisionIds = story.deploymentDecisionIds.map((id) => {
      const frozen = deployments.get(id);
      if (!frozen) throw new Error(`Unknown proposed deployment decision ${id}`);
      return frozen;
    });
  }
  draft.technologyDecisions = structuredClone(plan.technologyDecisions);
  draft.deploymentDecisions = structuredClone(plan.deploymentDecisions);
}
