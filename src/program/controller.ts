import { createHash } from 'node:crypto';
import type { PersistentTaskStore } from '../core/persistent-store.js';
import type { PortfolioPlan, ProgramRevision, ProjectConfig } from '../core/types.js';
import { StagingDeploymentController } from '../deployment/controller.js';
import { EvolutionSignalCollector } from '../evolution/signals.js';
import { REQUIRED_POST_MERGE_GITHUB_CHECKS, type GitHubControl } from '../github/control-plane.js';
import { PortfolioCoordinator } from '../portfolio/coordinator.js';
import { PortfolioPlanner, readRequirementsDocument } from '../portfolio/planner.js';
import { runProcess } from '../runtime/safe-process.js';
import { RepositoryAssessor } from './repository-assessor.js';

export interface ProgramTickResult {
  action: 'disabled' | 'idle' | 'deployed' | 'deployment-failed' | 'reassessed' | 'awaiting-material-approval' | 'delivered' | 'maintaining';
  planId: string | null;
  detail?: string;
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
    if (plan.status === 'blocked' && quarantine) {
      const key = `program:quarantine:${plan.id}:${quarantine.id}:${quarantine.identicalFailures}`;
      if (!this.store.hasIdempotencyKey(key)) {
        this.store.recordEvent('program.reassessment_requested', quarantine.id, { planId: plan.id, reason: 'quarantine' });
        const result = await this.reassess(plan, 'quarantine', signal);
        this.store.recordEvent('program.quarantine_processed', quarantine.id, { planId: plan.id, result: result.action }, key);
        return result;
      }
    }

    if (plan.status === 'assessing') return this.finishWave(plan, signal);
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
        this.store.recordEvent('program.signal_processed', null, { planId: plan.id, signalId: accepted.id, result: result.action }, `program:signal:${plan.id}:${accepted.id}`);
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
    const document = frozenRequirements(this.config.project.root, plan);
    const targetCommitSha = repositorySha ?? await this.remoteHead(signal);
    const deployment = plan.latestDeploymentId ? this.store.getDeployment(plan.latestDeploymentId) : null;
    const checks = await this.github.checksForRef(targetCommitSha, [...REQUIRED_POST_MERGE_GITHUB_CHECKS]);
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
    const assessment = await this.assessor.assess(document, signal, operationalEvidence, targetCommitSha);
    this.store.saveRepositoryAssessment(assessment);
    await this.recordExternalCommits(plan, assessment.commitSha, signal);
    const auditComplete = assessment.coverage.length > 0 && assessment.coverage.every((entry) => entry.status === 'implemented');
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
    const draft = await this.planner.plan(document, undefined, assessment);
    const material = materialRevision(plan, draft);
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
    const issueNumbers = new Set(plan.stories
      .filter((story) => !story.supersededAt && (story.wave ?? 1) === (plan.currentWave ?? 1))
      .flatMap((story) => story.normalizedIssueNumber === null ? [] : [story.normalizedIssueNumber]));
    return this.store.list(['quarantined']).find((task) => issueNumbers.has(task.issueNumber));
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

function frozenRequirements(root: string, plan: PortfolioPlan) {
  if (plan.sourceContent !== undefined) return { sourcePath: plan.sourcePath, content: plan.sourceContent };
  const document = readRequirementsDocument(root, plan.sourcePath);
  const currentHash = createHash('sha256').update(document.content).digest('hex');
  if (currentHash !== plan.contentHash) {
    throw new Error(`Approved objective ${plan.sourcePath} changed after approval; create and approve a material program revision instead`);
  }
  return document;
}

function materialRevision(plan: PortfolioPlan, draft: Awaited<ReturnType<PortfolioPlanner['plan']>>): boolean {
  const frozenTechnologies = JSON.stringify(plan.technologyDecisions.map(({ id, category, technology, source }) => ({ id, category, technology, source })));
  const nextTechnologies = JSON.stringify(draft.technologyDecisions.map(({ id, category, technology, source }) => ({ id, category, technology, source })));
  const frozenDeployments = JSON.stringify(plan.deploymentDecisions.map(({ id, component, provider, environment, authority }) => ({ id, component, provider, environment, authority })));
  const nextDeployments = JSON.stringify(draft.deploymentDecisions.map(({ id, component, provider, environment, authority }) => ({ id, component, provider, environment, authority })));
  return frozenTechnologies !== nextTechnologies || frozenDeployments !== nextDeployments || draft.technologyDecisions.some((decision) => decision.source === 'exception');
}
