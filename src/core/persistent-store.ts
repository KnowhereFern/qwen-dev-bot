import { existsSync, lstatSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { EventLedger, redactForLedger, redactText } from './ledger.js';
import { runProcess } from '../runtime/safe-process.js';
import { assertTaskTransition, isTaskLeased } from './task-state.js';
import type {
  ControllerRelease,
  DeploymentRecord,
  EvolutionSignal,
  HarnessEvent,
  PortfolioPlan,
  PortfolioPlanStatus,
  RewardScorecard,
  RepositoryAssessment,
  RunCheckpoint,
  TaskRecord,
  TaskSpec,
  TaskState,
} from './types.js';

interface TaskRow {
  id: string;
  project_id: string;
  issue_number: number;
  state: TaskState;
  priority: number;
  attempts: number;
  max_attempts: number;
  lease_expires_at: number | null;
  version: number;
  data: string;
}

interface PortfolioPlanRow {
  id: string;
  project_id: string;
  source_path: string;
  content_hash: string;
  status: PortfolioPlanStatus;
  updated_at: number;
  data: string;
}

export interface NewPersistentTask {
  issueNumber: number;
  title: string;
  body?: string;
  labels?: string[];
  author?: string;
  state?: TaskState;
  spec?: TaskSpec | null;
  priority?: number;
  maxAttempts?: number;
  failureLineageId?: string | null;
  lineageFailures?: number;
  identicalFailures?: number;
  lastFailureFingerprint?: string | null;
}

export interface SourceSnapshot {
  url: string;
  contentHash: string;
  checkedAt: number;
  changedAt: number;
  issueNumbers: number[];
}

export class PersistentTaskStore {
  readonly databaseFile: string;
  readonly ledger: EventLedger;
  private readonly db: DatabaseSync;

  constructor(
    readonly projectId: string,
    readonly stateDir: string,
  ) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.databaseFile = path.join(stateDir, 'state.sqlite3');
    this.db = new DatabaseSync(this.databaseFile);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        state TEXT NOT NULL,
        priority INTEGER NOT NULL,
        attempts INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        lease_expires_at INTEGER,
        version INTEGER NOT NULL,
        data TEXT NOT NULL,
        UNIQUE(project_id, issue_number)
      );
      CREATE INDEX IF NOT EXISTS tasks_claim_idx
        ON tasks(project_id, state, priority, issue_number);
      CREATE INDEX IF NOT EXISTS tasks_lease_idx
        ON tasks(project_id, lease_expires_at);
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        task_id TEXT,
        type TEXT NOT NULL,
        idempotency_key TEXT,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS events_idempotency_idx
        ON events(project_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS events_task_type_idx
        ON events(task_id, type);
      CREATE TABLE IF NOT EXISTS checkpoints (
        task_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY(task_id, phase, created_at)
      );
      CREATE TABLE IF NOT EXISTS scorecards (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        passed INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_snapshots (
        source_url TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        checked_at INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS portfolio_plans (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        data TEXT NOT NULL,
        UNIQUE(project_id, content_hash)
      );
      CREATE INDEX IF NOT EXISTS portfolio_plans_source_idx
        ON portfolio_plans(project_id, source_path, updated_at);
      CREATE TABLE IF NOT EXISTS repository_assessments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS repository_assessments_project_idx
        ON repository_assessments(project_id, created_at);
      CREATE TABLE IF NOT EXISTS evolution_signals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        source_key TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        data TEXT NOT NULL,
        UNIQUE(project_id, source_key, content_hash)
      );
      CREATE TABLE IF NOT EXISTS deployments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS deployments_plan_idx
        ON deployments(project_id, plan_id, updated_at);
      CREATE TABLE IF NOT EXISTS controller_releases (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
    this.ledger = new EventLedger(path.dirname(stateDir), projectId);
  }

  close(): void {
    this.db.close();
  }

  upsert(input: NewPersistentTask, now = Date.now()): TaskRecord {
    const existing = this.findByIssue(input.issueNumber);
    if (existing) {
      const specCanChange = ['intake', 'normalized', 'ready'].includes(existing.state);
      const updated: TaskRecord = {
        ...existing,
        title: input.title,
        body: input.body ?? existing.body,
        labels: input.labels ? [...input.labels] : existing.labels,
        author: input.author ?? existing.author,
        spec: input.spec === undefined || !specCanChange ? existing.spec : input.spec,
        priority: input.priority ?? existing.priority,
        updatedAt: now,
        version: existing.version + 1,
      };
      this.writeTask(updated, existing.version);
      this.recordEvent('task.updated', updated.id, { issueNumber: updated.issueNumber, state: updated.state });
      return updated;
    }

    const id = `task_${createHash('sha256')
      .update(`${this.projectId}:${input.issueNumber}`)
      .digest('hex')
      .slice(0, 20)}`;
    const task: TaskRecord = {
      id,
      projectId: this.projectId,
      issueNumber: input.issueNumber,
      title: input.title,
      body: input.body ?? '',
      labels: [...(input.labels ?? [])],
      author: input.author ?? '',
      state: input.state ?? 'intake',
      spec: input.spec ?? null,
      priority: input.priority ?? 0,
      attempts: 0,
      continuations: 0,
      waitKind: null,
      resumeAfter: null,
      identicalFailures: input.identicalFailures ?? 0,
      lastFailureFingerprint: input.lastFailureFingerprint ?? null,
      failureLineageId: input.failureLineageId ?? null,
      lineageFailures: input.lineageFailures ?? 0,
      maxAttempts: input.maxAttempts ?? 5,
      leaseOwner: null,
      leaseExpiresAt: null,
      baseSha: null,
      branch: null,
      worktreePath: null,
      commitSha: null,
      qwenSessionId: null,
      qwenWorkflowRunId: null,
      qwenAutomaticStop: null,
      prNumber: null,
      prUrl: null,
      mergeSha: null,
      rewardRunId: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    this.writeTask(task);
    this.recordEvent('task.created', task.id, { issueNumber: task.issueNumber, state: task.state });
    return task;
  }

  get(id: string): TaskRecord {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ? AND project_id = ?').get(id, this.projectId);
    if (!row) throw new Error(`Unknown task id: ${id}`);
    return rowToTask(row as unknown as TaskRow);
  }

  findByIssue(issueNumber: number): TaskRecord | null {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE project_id = ? AND issue_number = ?')
      .get(this.projectId, issueNumber);
    return row ? rowToTask(row as unknown as TaskRow) : null;
  }

  list(states?: TaskState[]): TaskRecord[] {
    if (!states || states.length === 0) {
      return (this.db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY issue_number').all(this.projectId) as unknown as TaskRow[]).map(rowToTask);
    }
    const placeholders = states.map(() => '?').join(',');
    return (
      this.db
        .prepare(`SELECT * FROM tasks WHERE project_id = ? AND state IN (${placeholders}) ORDER BY priority, issue_number`)
        .all(this.projectId, ...states) as unknown as TaskRow[]
    ).map(rowToTask);
  }

  savePortfolioPlan(plan: PortfolioPlan): PortfolioPlan {
    if (plan.projectId !== this.projectId) {
      throw new Error(`Portfolio plan ${plan.id} belongs to another project`);
    }
    this.db
      .prepare(
        `INSERT INTO portfolio_plans(id, project_id, source_path, content_hash, status, updated_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           source_path=excluded.source_path, content_hash=excluded.content_hash,
           status=excluded.status, updated_at=excluded.updated_at, data=excluded.data`,
      )
      .run(
        plan.id,
        plan.projectId,
        plan.sourcePath,
        plan.contentHash,
        plan.status,
        plan.updatedAt,
        JSON.stringify(plan),
      );
    return plan;
  }

  getPortfolioPlan(id: string): PortfolioPlan | null {
    const row = this.db
      .prepare('SELECT * FROM portfolio_plans WHERE id = ? AND project_id = ?')
      .get(id, this.projectId) as unknown as PortfolioPlanRow | undefined;
    return row ? rowToPortfolioPlan(row) : null;
  }

  findPortfolioPlanByHash(contentHash: string): PortfolioPlan | null {
    const row = this.db
      .prepare('SELECT * FROM portfolio_plans WHERE project_id = ? AND content_hash = ?')
      .get(this.projectId, contentHash) as unknown as PortfolioPlanRow | undefined;
    return row ? rowToPortfolioPlan(row) : null;
  }

  listPortfolioPlans(): PortfolioPlan[] {
    return (
      this.db
        .prepare('SELECT * FROM portfolio_plans WHERE project_id = ? ORDER BY updated_at DESC, id DESC')
        .all(this.projectId) as unknown as PortfolioPlanRow[]
    ).map(rowToPortfolioPlan);
  }

  saveRepositoryAssessment(assessment: RepositoryAssessment): RepositoryAssessment {
    if (assessment.projectId !== this.projectId) throw new Error(`Repository assessment ${assessment.id} belongs to another project`);
    this.db.prepare(
      `INSERT INTO repository_assessments(id, project_id, commit_sha, created_at, data)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET commit_sha=excluded.commit_sha, created_at=excluded.created_at, data=excluded.data`,
    ).run(assessment.id, assessment.projectId, assessment.commitSha, assessment.createdAt, JSON.stringify(assessment));
    this.recordEvent('program.assessment_saved', null, { assessmentId: assessment.id, commitSha: assessment.commitSha });
    return assessment;
  }

  getRepositoryAssessment(id: string): RepositoryAssessment | null {
    const row = this.db.prepare('SELECT data FROM repository_assessments WHERE id = ? AND project_id = ?').get(id, this.projectId) as { data?: string } | undefined;
    return row?.data ? JSON.parse(row.data) as RepositoryAssessment : null;
  }

  listRepositoryAssessments(): RepositoryAssessment[] {
    const rows = this.db.prepare('SELECT data FROM repository_assessments WHERE project_id = ? ORDER BY created_at DESC, id DESC').all(this.projectId) as Array<{ data: string }>;
    return rows.map((row) => JSON.parse(row.data) as RepositoryAssessment);
  }

  saveSignal(signal: EvolutionSignal): EvolutionSignal {
    if (signal.projectId !== this.projectId) throw new Error(`Signal ${signal.id} belongs to another project`);
    const existing = this.db.prepare(
      'SELECT data FROM evolution_signals WHERE project_id = ? AND source_key = ? AND content_hash = ?',
    ).get(this.projectId, signal.sourceKey, signal.contentHash) as { data?: string } | undefined;
    if (existing?.data) {
      const parsed = JSON.parse(existing.data) as EvolutionSignal;
      if (parsed.id !== signal.id || (parsed.status === signal.status && parsed.updatedAt >= signal.updatedAt)) return parsed;
    }
    this.db.prepare(
      `INSERT INTO evolution_signals(id, project_id, source_key, content_hash, status, updated_at, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at, data=excluded.data`,
    ).run(signal.id, signal.projectId, signal.sourceKey, signal.contentHash, signal.status, signal.updatedAt, JSON.stringify(signal));
    this.recordEvent('evolution.signal_saved', null, { signalId: signal.id, source: signal.source, status: signal.status }, `signal:${signal.sourceKey}:${signal.contentHash}`);
    return signal;
  }

  listSignals(): EvolutionSignal[] {
    const rows = this.db.prepare('SELECT data FROM evolution_signals WHERE project_id = ? ORDER BY updated_at DESC, id DESC').all(this.projectId) as Array<{ data: string }>;
    return rows.map((row) => JSON.parse(row.data) as EvolutionSignal);
  }

  saveDeployment(deployment: DeploymentRecord): DeploymentRecord {
    if (deployment.projectId !== this.projectId) throw new Error(`Deployment ${deployment.id} belongs to another project`);
    this.db.prepare(
      `INSERT INTO deployments(id, project_id, plan_id, commit_sha, status, updated_at, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at, data=excluded.data`,
    ).run(deployment.id, deployment.projectId, deployment.planId, deployment.commitSha, deployment.status, deployment.updatedAt, JSON.stringify(deployment));
    this.recordEvent('deployment.saved', null, { deploymentId: deployment.id, planId: deployment.planId, commitSha: deployment.commitSha, status: deployment.status });
    return deployment;
  }

  getDeployment(id: string): DeploymentRecord | null {
    const row = this.db.prepare('SELECT data FROM deployments WHERE id = ? AND project_id = ?').get(id, this.projectId) as { data?: string } | undefined;
    return row?.data ? JSON.parse(row.data) as DeploymentRecord : null;
  }

  listDeployments(planId?: string): DeploymentRecord[] {
    const rows = (planId
      ? this.db.prepare('SELECT data FROM deployments WHERE project_id = ? AND plan_id = ? ORDER BY updated_at DESC, id DESC').all(this.projectId, planId)
      : this.db.prepare('SELECT data FROM deployments WHERE project_id = ? ORDER BY updated_at DESC, id DESC').all(this.projectId)) as Array<{ data: string }>;
    return rows.map((row) => JSON.parse(row.data) as DeploymentRecord);
  }

  saveControllerRelease(release: ControllerRelease): ControllerRelease {
    this.db.prepare(
      `INSERT INTO controller_releases(id, project_id, commit_sha, status, updated_at, data)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at, data=excluded.data`,
    ).run(release.id, this.projectId, release.commitSha, release.status, release.updatedAt, JSON.stringify(release));
    this.recordEvent('controller.release_saved', null, { releaseId: release.id, commitSha: release.commitSha, status: release.status });
    return release;
  }

  listControllerReleases(): ControllerRelease[] {
    const rows = this.db.prepare('SELECT data FROM controller_releases WHERE project_id = ? ORDER BY updated_at DESC, id DESC').all(this.projectId) as Array<{ data: string }>;
    return rows.map((row) => JSON.parse(row.data) as ControllerRelease);
  }

  countTaskEvents(taskId: string, type: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS total FROM events WHERE project_id = ? AND task_id = ? AND type = ?')
      .get(this.projectId, taskId, type) as { total?: number | bigint } | undefined;
    return Number(row?.total ?? 0);
  }

  listEvents(type?: string): HarnessEvent[] {
    const rows = (type
      ? this.db.prepare('SELECT * FROM events WHERE project_id = ? AND type = ? ORDER BY created_at').all(this.projectId, type)
      : this.db.prepare('SELECT * FROM events WHERE project_id = ? ORDER BY created_at').all(this.projectId)) as Array<Record<string, unknown>>;
    return rows.map(eventRowToEvent);
  }

  transition(id: string, to: TaskState, patch: Partial<TaskRecord> = {}, now = Date.now()): TaskRecord {
    const current = this.get(id);
    assertTaskTransition(current.state, to);
    const next: TaskRecord = {
      ...current,
      ...patch,
      id: current.id,
      projectId: current.projectId,
      issueNumber: current.issueNumber,
      state: to,
      updatedAt: now,
      version: current.version + 1,
    };
    this.writeTask(next, current.version);
    this.recordEvent('task.transition', id, { from: current.state, to, version: next.version });
    return next;
  }

  patch(id: string, patch: Partial<TaskRecord>, now = Date.now()): TaskRecord {
    const current = this.get(id);
    const next: TaskRecord = {
      ...current,
      ...patch,
      id: current.id,
      projectId: current.projectId,
      issueNumber: current.issueNumber,
      state: current.state,
      updatedAt: now,
      version: current.version + 1,
    };
    this.writeTask(next, current.version);
    return next;
  }

  claimNext(workerId: string, leaseMs: number, now = Date.now()): TaskRecord | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db
        .prepare(
          `SELECT * FROM tasks
           WHERE project_id = ? AND state = 'ready'
           ORDER BY priority ASC, issue_number ASC`,
        )
        .all(this.projectId) as unknown as TaskRow[];
      const dependencyTasks = (
        this.db.prepare('SELECT * FROM tasks WHERE project_id = ?').all(this.projectId) as unknown as TaskRow[]
      ).map(rowToTask);
      const row = rows.find((candidate) => {
        const task = rowToTask(candidate);
        if (!this.portfolioStoryLeaseAuthorized(task)) return false;
        const budget = this.failureBudget(task, dependencyTasks);
        if (budget.failures >= budget.limit) {
          this.transition(task.id, 'quarantined', {}, now);
          this.recordEvent('task.lineage_budget_exhausted', task.id, {
            failureLineageId: task.failureLineageId ?? task.id,
            failures: budget.failures,
            maxAttempts: budget.limit,
          });
          return false;
        }
        if (budget.members.some((member) => member.id !== task.id && isTaskLeased(member.state))) return false;
        return this.dependenciesSatisfied(task, dependencyTasks);
      });
      if (!row) {
        this.db.exec('COMMIT');
        return null;
      }
      const current = rowToTask(row);
      const next: TaskRecord = {
        ...current,
        state: 'leased',
        leaseOwner: workerId,
        leaseExpiresAt: now + leaseMs,
        updatedAt: now,
        version: current.version + 1,
      };
      this.writeTask(next, current.version);
      const payload = {
        workerId,
        leaseExpiresAt: next.leaseExpiresAt,
        dependencies: current.spec?.dependencies ?? [],
      };
      this.insertEvent(this.makeEvent('task.claimed', current.id, payload));
      this.db.exec('COMMIT');
      this.ledger.append({
        projectId: this.projectId,
        taskId: current.id,
        type: 'task.claimed',
        idempotencyKey: null,
        payload,
      });
      return next;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  claimReconciliation(
    workerId: string,
    leaseMs: number,
    states: TaskState[],
    now = Date.now(),
    excludedTaskIds: string[] = [],
  ): TaskRecord | null {
    if (states.length === 0) return null;
    const placeholders = states.map(() => '?').join(',');
    const excludedClause =
      excludedTaskIds.length > 0
        ? ` AND id NOT IN (${excludedTaskIds.map(() => '?').join(',')})`
        : '';
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare(
          `SELECT * FROM tasks
           WHERE project_id = ? AND state IN (${placeholders}) AND lease_expires_at IS NULL${excludedClause}
           ORDER BY priority ASC, issue_number ASC
           LIMIT 1`,
        )
        .get(this.projectId, ...states, ...excludedTaskIds) as unknown as TaskRow | undefined;
      if (!row) {
        this.db.exec('COMMIT');
        return null;
      }
      const current = rowToTask(row);
      const next: TaskRecord = {
        ...current,
        leaseOwner: workerId,
        leaseExpiresAt: now + leaseMs,
        updatedAt: now,
        version: current.version + 1,
      };
      this.writeTask(next, current.version);
      const payload = { workerId, state: current.state, leaseExpiresAt: next.leaseExpiresAt };
      this.insertEvent(this.makeEvent('task.reconciliation_claimed', current.id, payload));
      this.db.exec('COMMIT');
      this.ledger.append({
        projectId: this.projectId,
        taskId: current.id,
        type: 'task.reconciliation_claimed',
        idempotencyKey: null,
        payload,
      });
      return next;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Claim-time authorization for portfolio-story tasks. A ready task that
   * corresponds to a saved portfolio story may be leased only when some saved
   * plan maps it to an unsuperseded story of an approved active/blocked
   * program revision whose wave has been reached (story.wave <=
   * plan.currentWave). Future-wave, pending-material-revision, and superseded
   * portfolio tasks are held without consuming attempts or altering state;
   * tasks with no portfolio story (legacy issue-driven work) pass unchanged.
   */
  private portfolioStoryLeaseAuthorized(task: TaskRecord): boolean {
    const matches = this.listPortfolioPlans().flatMap((plan) =>
      plan.stories
        .filter(
          (story) =>
            story.normalizedIssueNumber === task.issueNumber ||
            story.sourceIssueNumber === task.issueNumber,
        )
        .map((story) => ({ plan, story })),
    );
    if (matches.length === 0) return true;
    return matches.some(({ plan, story }) => {
      if (!plan.approvedAt || !['active', 'blocked'].includes(plan.status)) return false;
      if (story.supersededAt) return false;
      if (story.wave !== undefined && plan.currentWave !== undefined && story.wave > plan.currentWave) {
        return false;
      }
      if (story.revision !== undefined && plan.revisions?.length) {
        const revision = plan.revisions.find((entry) => entry.number === story.revision);
        if (!revision || revision.rejectedAt !== undefined || revision.approvedAt === null) return false;
      }
      return true;
    });
  }

  private dependenciesSatisfied(task: TaskRecord, candidates: TaskRecord[]): boolean {
    const dependencies = [...new Set(task.spec?.dependencies ?? [])];
    return dependencies.every((issueNumber) =>
      candidates.some(
        (candidate) =>
          candidate.state === 'done' &&
          (candidate.issueNumber === issueNumber || sourceIssueNumber(candidate.spec?.source.url) === issueNumber),
      ) || this.dependencySatisfiedByApprovedCoverage(task, issueNumber, candidates),
    );
  }

  private dependencySatisfiedByApprovedCoverage(task: TaskRecord, issueNumber: number, candidates: TaskRecord[]): boolean {
    return this.listPortfolioPlans().some((plan) => {
      if (!plan.approvedAt || !['active', 'blocked'].includes(plan.status) || !plan.repositorySha) return false;
      const dependent = plan.stories.find((story) => story.normalizedIssueNumber === task.issueNumber && !story.supersededAt);
      const dependency = plan.stories.find((story) =>
        story.sourceIssueNumber === issueNumber || story.normalizedIssueNumber === issueNumber);
      if (!dependent || !dependency?.supersededAt || !dependent.dependsOn.includes(dependency.key) ||
          !dependency.coverageIds?.length) return false;
      const covered = dependency.coverageIds.every((id) => {
        const entry = plan.coverage?.find((item) => item.id === id);
        return entry?.status === 'implemented' && entry.requiredAction === 'none' &&
          entry.evidence.some((evidence) =>
            ['test', 'deployment'].includes(evidence.kind) && evidence.commitSha === plan.repositorySha);
      });
      if (!covered) return false;
      const prior = candidates.find((candidate) => candidate.issueNumber === dependency.normalizedIssueNumber);
      return !prior || (prior.state === 'cancelled' && prior.attempts === 0 &&
        prior.leaseOwner === null && prior.leaseExpiresAt === null && prior.baseSha === null &&
        prior.branch === null && prior.worktreePath === null && prior.commitSha === null &&
        prior.qwenSessionId === null && prior.qwenWorkflowRunId === null && prior.prNumber === null &&
        prior.prUrl === null && prior.mergeSha === null && prior.rewardRunId === null);
    });
  }

  heartbeat(id: string, workerId: string, leaseMs: number, now = Date.now()): TaskRecord {
    const task = this.get(id);
    if (!isTaskLeased(task.state) || task.leaseOwner !== workerId) {
      throw new Error(`Cannot heartbeat task ${id}: lease is not owned by ${workerId}`);
    }
    return this.patch(id, { leaseExpiresAt: now + leaseMs }, now);
  }

  expired(now = Date.now()): TaskRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM tasks
           WHERE project_id = ? AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
        )
        .all(this.projectId, now) as unknown as TaskRow[]
    )
      .map(rowToTask)
      .filter((task) => isTaskLeased(task.state));
  }

  recordFailure(
    id: string,
    error: string,
    identicalLimit: number,
    now = Date.now(),
  ): TaskRecord {
    const task = this.get(id);
    if (!isTaskLeased(task.state) && task.state !== 'waiting') {
      throw new Error(`Cannot record a failed attempt from state ${task.state}`);
    }
    error = redactText(error);
    const fingerprint = failureFingerprint(error);
    const identicalFailures = task.lastFailureFingerprint === fingerprint ? task.identicalFailures + 1 : 1;
    const attempts = task.attempts + 1;
    const budget = this.failureBudget(task);
    const lineageFailures = budget.failures + 1;
    const to: TaskState =
      identicalFailures >= identicalLimit ? 'quarantined' : lineageFailures >= budget.limit ? 'failed' : 'ready';
    return this.transition(
      id,
      to,
      {
        attempts,
        identicalFailures,
        lastFailureFingerprint: fingerprint,
        failureLineageId: task.failureLineageId ?? task.id,
        lineageFailures,
        lastError: error,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
      now,
    );
  }

  recordPostMergeFailure(
    id: string,
    error: string,
    identicalLimit: number,
    now = Date.now(),
  ): TaskRecord {
    const task = this.get(id);
    if (task.state !== 'post_merge') {
      throw new Error(`Cannot record a post-merge failure from state ${task.state}`);
    }
    error = redactText(error);
    const fingerprint = failureFingerprint(error);
    const identicalFailures = task.lastFailureFingerprint === fingerprint ? task.identicalFailures + 1 : 1;
    const attempts = task.attempts + 1;
    const budget = this.failureBudget(task);
    const lineageFailures = budget.failures + 1;
    const patch = {
      attempts,
      identicalFailures,
      lastFailureFingerprint: fingerprint,
      failureLineageId: task.failureLineageId ?? task.id,
      lineageFailures,
      lastError: error,
      leaseOwner: null,
      leaseExpiresAt: null,
    };
    if (identicalFailures >= identicalLimit) return this.transition(id, 'quarantined', patch, now);
    if (lineageFailures >= budget.limit) return this.transition(id, 'failed', patch, now);
    const updated = this.patch(id, patch, now);
    this.recordEvent('postmerge.retry_scheduled', id, { attempts, identicalFailures });
    return updated;
  }

  retryBudget(id: string): { failures: number; limit: number } {
    const { failures, limit } = this.failureBudget(this.get(id));
    return { failures, limit };
  }

  authorizeRecovery(id: string, authorization: {
    authorizationId: string; additionalAttempts: number; authorizedBy: string; reason: string;
    allowGitRm?: string[];
  }): TaskRecord {
    if (!Number.isSafeInteger(authorization.additionalAttempts) || authorization.additionalAttempts < 1 || authorization.additionalAttempts > 3 ||
        [authorization.authorizationId, authorization.authorizedBy, authorization.reason].some((value) => typeof value !== 'string' || !value.trim())) {
      throw new Error('Recovery requires a named authorization, author, reason and 1-3 additional attempts');
    }
    const allowGitRm = authorization.allowGitRm ?? [];
    for (const requested of allowGitRm) assertSafeGitRmPathSyntax(requested);
    const binding = createHash('sha256').update(JSON.stringify({ id, authorizationId: authorization.authorizationId,
      additionalAttempts: authorization.additionalAttempts, authorizedBy: authorization.authorizedBy, reason: authorization.reason,
      ...(allowGitRm.length === 0 ? {} : { allowGitRm }) })).digest('hex');
    const key = `task:recovery:${authorization.authorizationId}`;
    let event: HarnessEvent | undefined;
    let result: TaskRecord;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.listEvents('task.recovery_authorized').find((entry) => entry.idempotencyKey === key);
      if (prior) {
        if (prior.payload.binding !== binding) throw new Error('Recovery authorization conflicts with its original binding');
        result = this.get(id);
      } else {
        const current = this.get(id);
        const budget = this.failureBudget(current);
        if (!['failed', 'quarantined'].includes(current.state) || budget.failures < budget.limit) {
          throw new Error('Recovery authorization requires an exhausted failed or quarantined task');
        }
        if (budget.members.some((member) => isTaskLeased(member.state))) throw new Error('Recovery lineage still has active execution');
        if (current.mergeSha) throw new Error('Merged tasks require post-merge recovery, not implementation reentry');
        if (allowGitRm.length > 0 && typeof current.worktreePath !== 'string') {
          throw new Error('Tracked-file removal authorization requires the failed task worktree');
        }
        const now = Date.now();
        result = { ...current, state: 'ready', updatedAt: now, version: current.version + 1, leaseOwner: null, leaseExpiresAt: null };
        event = this.makeEvent('task.recovery_authorized', id, {
          binding, authorizationId: authorization.authorizationId,
          authorizedBy: redactText(authorization.authorizedBy), reason: redactText(authorization.reason),
          additionalAttempts: authorization.additionalAttempts,
          failureLineageId: current.failureLineageId ?? current.id,
          failures: budget.failures, priorLimit: budget.limit, absoluteLimit: budget.failures + authorization.additionalAttempts,
          priorState: current.state, priorVersion: current.version,
          ...(allowGitRm.length === 0 ? {} : { allowGitRm }),
          contractHash: createHash('sha256').update(JSON.stringify(current.spec)).digest('hex'),
        }, key);
        this.writeTask(result, current.version);
        this.insertEvent(event);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    if (event) this.ledger.append(event);
    return result;
  }

  /**
   * Attach narrow tracked-file removal permission to an already-ready
   * recovered task without adding another attempt. The grant is an
   * append-only, idempotent event bound to the exact task, the current
   * contract hash, the current active recovery authorization, the exact
   * validated paths, and the operator input. Task state, attempts, and the
   * retry budget are never changed; replaying the exact grant is a no-op and
   * reusing its authorization ID with a different binding is rejected.
   */
  grantGitRmPermission(id: string, grant: {
    authorizationId: string; authorizedBy: string; reason: string; allowGitRm: string[];
  }): { recoveryAuthorizationId: string; contractHash: string } {
    const allowGitRm = grant.allowGitRm ?? [];
    if (!Array.isArray(allowGitRm) || allowGitRm.length === 0 || allowGitRm.length > GIT_RM_MAX_PATHS ||
        !allowGitRm.every((entry) => typeof entry === 'string') ||
        [grant.authorizationId, grant.authorizedBy, grant.reason].some((value) => typeof value !== 'string' || !value.trim())) {
      throw new Error(`Tracked-file removal grant requires a named authorization, author, reason and 1-${GIT_RM_MAX_PATHS} paths`);
    }
    for (const requested of allowGitRm) assertSafeGitRmPathSyntax(requested);
    const operatorBinding = createHash('sha256').update(JSON.stringify({ id, authorizationId: grant.authorizationId,
      authorizedBy: grant.authorizedBy, reason: grant.reason, allowGitRm })).digest('hex');
    const key = `task:git-rm-grant:${grant.authorizationId}`;
    let event: HarnessEvent | undefined;
    let result: { recoveryAuthorizationId: string; contractHash: string };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.listEvents('task.git_rm_granted').find((entry) => entry.idempotencyKey === key);
      if (prior) {
        if (prior.payload.operatorBinding !== operatorBinding) {
          throw new Error('Tracked-file removal grant conflicts with its original binding');
        }
        const current = this.get(id);
        const contractHash = createHash('sha256').update(JSON.stringify(current.spec)).digest('hex');
        const recovery = this.listEvents('task.recovery_authorized').filter((entry) => entry.taskId === id).at(-1);
        if (prior.taskId !== id || prior.payload.contractHash !== contractHash ||
            prior.payload.recoveryAuthorizationId !== recovery?.payload.authorizationId) {
          throw new Error('Tracked-file removal grant is stale for the current task or recovery');
        }
        result = { recoveryAuthorizationId: String(prior.payload.recoveryAuthorizationId), contractHash: String(prior.payload.contractHash) };
      } else {
        const current = this.get(id);
        if (current.state !== 'ready' || current.leaseOwner !== null || current.leaseExpiresAt !== null) {
          throw new Error('Tracked-file removal grant requires an unleased ready task');
        }
        if (typeof current.worktreePath !== 'string' || !current.worktreePath.trim()) {
          throw new Error('Tracked-file removal grant requires the task worktree');
        }
        const contractHash = createHash('sha256').update(JSON.stringify(current.spec)).digest('hex');
        const recovery = this.listEvents('task.recovery_authorized').filter((entry) => entry.taskId === id).at(-1);
        if (!recovery || recovery.payload.contractHash !== contractHash ||
            typeof recovery.payload.authorizationId !== 'string' || !recovery.payload.authorizationId) {
          throw new Error('Tracked-file removal grant requires an active recovery authorization for the current contract');
        }
        const budget = this.failureBudget(current);
        if (budget.failures >= budget.limit) {
          throw new Error('Tracked-file removal grant requires remaining retry budget');
        }
        event = this.makeEvent('task.git_rm_granted', id, {
          operatorBinding, authorizationId: grant.authorizationId,
          authorizedBy: redactText(grant.authorizedBy), reason: redactText(grant.reason),
          recoveryAuthorizationId: recovery.payload.authorizationId,
          allowGitRm, contractHash,
          failures: budget.failures, limit: budget.limit, taskVersion: current.version,
        }, key);
        this.insertEvent(event);
        result = { recoveryAuthorizationId: String(event.payload.recoveryAuthorizationId), contractHash };
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    if (event) this.ledger.append(event);
    return result;
  }

  /**
   * Record an append-only operator feedback event for an unleased ready task
   * with remaining retry budget and an existing worktree. Bind it to the
   * candidate commit held at review time. Patches lastError so
   * the next repair prompt carries the finding; never resets or creates
   * attempts and never changes the contract, history, or permissions.
   */
  recordOperatorFeedback(
    id: string,
    feedback: { authorizationId: string; authorizedBy: string; reason: string },
    now = Date.now(),
  ): TaskRecord {
    if ([feedback.authorizationId, feedback.authorizedBy, feedback.reason].some((value) => typeof value !== 'string' || !value.trim())) {
      throw new Error('Operator feedback requires a named authorization, author, and reason');
    }
    const reason = redactText(feedback.reason).trim();
    const key = `task:feedback:${feedback.authorizationId}`;
    let event: HarnessEvent | undefined;
    let result: TaskRecord;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.listEvents('task.operator_feedback').find((entry) => entry.idempotencyKey === key);
      const current = this.get(id);
      const contractHash = createHash('sha256').update(JSON.stringify(current.spec)).digest('hex');
      const candidateCommitSha = current.commitSha;
      const binding = createHash('sha256').update(JSON.stringify({
        id,
        issueNumber: current.issueNumber,
        authorizationId: feedback.authorizationId,
        authorizedBy: redactText(feedback.authorizedBy),
        reason,
        contractHash,
        candidateCommitSha,
      })).digest('hex');
      if (prior) {
        if (prior.payload.binding !== binding) throw new Error('Operator feedback authorization conflicts with its original binding');
        this.db.exec('COMMIT');
        return current;
      }
      if (current.state !== 'ready' || current.leaseOwner !== null || current.leaseExpiresAt !== null) {
        throw new Error(`Operator feedback requires an unleased ready task, not ${current.state}`);
      }
      if (current.mergeSha) throw new Error('Merged tasks are not eligible for operator feedback');
      const budget = this.failureBudget(current);
      if (budget.failures >= budget.limit) throw new Error('Operator feedback requires remaining retry budget');
      if (!current.worktreePath || !existsSync(current.worktreePath)) throw new Error('Operator feedback requires an existing task worktree');
      result = this.patch(id, { lastError: `Operator feedback (${feedback.authorizationId}): ${reason}` }, now);
      event = this.makeEvent('task.operator_feedback', id, {
        binding,
        authorizationId: feedback.authorizationId,
        authorizedBy: redactText(feedback.authorizedBy),
        reason,
        issueNumber: current.issueNumber,
        attempts: current.attempts,
        maxAttempts: current.maxAttempts,
        contractHash,
        candidateCommitSha,
        priorVersion: current.version,
      }, key);
      this.insertEvent(event);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    if (event) this.ledger.append(event);
    return result;
  }

  private failureBudget(task: TaskRecord, tasks = this.list()) {
    const lineageId = task.failureLineageId ?? task.id;
    const members = tasks.filter((member) => (member.failureLineageId ?? member.id) === lineageId);
    return {
      members,
      // Own attempt counts are additive; inherited cumulative snapshots are not.
      // The maximum also preserves historical counts when an origin is unavailable.
      failures: Math.max(
        members.reduce((total, member) => total + member.attempts, 0),
        ...members.map((member) => member.lineageFailures ?? 0),
      ),
      limit: Math.max(
        Math.min(task.maxAttempts, ...members.map((member) => member.maxAttempts)),
        ...this.listEvents('task.recovery_authorized')
          .filter((event) => event.payload.failureLineageId === lineageId)
          .map((event) => Number(event.payload.absoluteLimit)),
      ),
    };
  }

  saveCheckpoint(checkpoint: RunCheckpoint): void {
    this.db
      .prepare('INSERT OR REPLACE INTO checkpoints(task_id, phase, created_at, data) VALUES (?, ?, ?, ?)')
      .run(checkpoint.taskId, checkpoint.phase, checkpoint.createdAt, JSON.stringify(checkpoint));
    this.recordEvent('checkpoint.saved', checkpoint.taskId, { phase: checkpoint.phase, createdAt: checkpoint.createdAt });
  }

  latestCheckpoint(taskId: string): RunCheckpoint | null {
    const row = this.db
      .prepare('SELECT data FROM checkpoints WHERE task_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(taskId) as { data?: string } | undefined;
    return row?.data ? (JSON.parse(row.data) as RunCheckpoint) : null;
  }

  saveScorecard(scorecard: RewardScorecard): void {
    this.db
      .prepare('INSERT OR REPLACE INTO scorecards(id, task_id, commit_sha, passed, created_at, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        scorecard.id,
        scorecard.taskId,
        scorecard.commitSha,
        scorecard.passed ? 1 : 0,
        scorecard.createdAt,
        JSON.stringify(scorecard),
      );
    this.patch(scorecard.taskId, { rewardRunId: scorecard.id });
    this.recordEvent('reward.completed', scorecard.taskId, {
      rewardRunId: scorecard.id,
      passed: scorecard.passed,
      aggregateScore: scorecard.aggregateScore,
    });
  }

  getScorecard(id: string): RewardScorecard | null {
    const row = this.db.prepare('SELECT data FROM scorecards WHERE id = ?').get(id) as { data?: string } | undefined;
    return row?.data ? (JSON.parse(row.data) as RewardScorecard) : null;
  }

  listScorecards(): RewardScorecard[] {
    const rows = this.db.prepare('SELECT data FROM scorecards ORDER BY created_at, id').all() as Array<{ data: string }>;
    return rows.map((row) => JSON.parse(row.data) as RewardScorecard);
  }

  getSourceSnapshot(url: string): SourceSnapshot | null {
    const row = this.db.prepare('SELECT data FROM source_snapshots WHERE source_url = ?').get(url) as
      | { data?: string }
      | undefined;
    return row?.data ? (JSON.parse(row.data) as SourceSnapshot) : null;
  }

  saveSourceSnapshot(snapshot: SourceSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO source_snapshots(source_url, content_hash, checked_at, data)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source_url) DO UPDATE SET
           content_hash=excluded.content_hash, checked_at=excluded.checked_at, data=excluded.data`,
      )
      .run(snapshot.url, snapshot.contentHash, snapshot.checkedAt, JSON.stringify(snapshot));
    this.recordEvent('community.source_checked', null, {
      url: snapshot.url,
      contentHash: snapshot.contentHash,
      issueNumbers: snapshot.issueNumbers,
    });
  }

  hasIdempotencyKey(key: string): boolean {
    return Boolean(
      this.db
        .prepare('SELECT 1 AS found FROM events WHERE project_id = ? AND idempotency_key = ?')
        .get(this.projectId, key),
    );
  }

  recordEvent(
    type: string,
    taskId: string | null,
    payload: Record<string, unknown>,
    idempotencyKey: string | null = null,
  ): HarnessEvent {
    const event = this.makeEvent(
      type,
      taskId,
      redactForLedger(payload) as Record<string, unknown>,
      idempotencyKey,
    );
    try {
      this.insertEvent(event);
    } catch (error) {
      if (idempotencyKey && String(error).includes('UNIQUE constraint failed')) {
        const existing = this.db
          .prepare('SELECT * FROM events WHERE project_id = ? AND idempotency_key = ?')
          .get(this.projectId, idempotencyKey) as Record<string, unknown> | undefined;
        if (existing) return eventRowToEvent(existing);
      }
      throw error;
    }
    this.ledger.append(event);
    return event;
  }

  private makeEvent(
    type: string,
    taskId: string | null,
    payload: Record<string, unknown>,
    idempotencyKey: string | null = null,
  ): HarnessEvent {
    return {
      id: randomUUID(),
      projectId: this.projectId,
      taskId,
      type,
      idempotencyKey,
      payload,
      createdAt: Date.now(),
    };
  }

  private insertEvent(event: HarnessEvent): void {
    this.db
      .prepare(
        'INSERT INTO events(id, project_id, task_id, type, idempotency_key, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        event.id,
        event.projectId,
        event.taskId,
        event.type,
        event.idempotencyKey,
        JSON.stringify(event.payload),
        event.createdAt,
      );
  }

  private writeTask(task: TaskRecord, expectedVersion?: number): void {
    if (expectedVersion === undefined) {
      this.db
        .prepare(
          `INSERT INTO tasks(id, project_id, issue_number, state, priority, attempts, max_attempts, lease_expires_at, version, data)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             state=excluded.state, priority=excluded.priority, attempts=excluded.attempts,
             max_attempts=excluded.max_attempts, lease_expires_at=excluded.lease_expires_at,
             version=excluded.version, data=excluded.data`,
        )
        .run(
          task.id,
          task.projectId,
          task.issueNumber,
          task.state,
          task.priority,
          task.attempts,
          task.maxAttempts,
          task.leaseExpiresAt,
          task.version,
          JSON.stringify(task),
        );
      return;
    }
    const result = this.db
      .prepare(
        `UPDATE tasks SET state=?, priority=?, attempts=?, max_attempts=?, lease_expires_at=?, version=?, data=?
         WHERE id=? AND project_id=? AND version=?`,
      )
      .run(
        task.state,
        task.priority,
        task.attempts,
        task.maxAttempts,
        task.leaseExpiresAt,
        task.version,
        JSON.stringify(task),
        task.id,
        task.projectId,
        expectedVersion,
      );
    if (Number(result.changes) !== 1) throw new Error(`Concurrent task update rejected for ${task.id}`);
  }
}

/** Maximum number of tracked files a single recovery authorization may allow. */
export const GIT_RM_MAX_PATHS = 5;

/**
 * Basename patterns that mark a repository path as credential-bearing. Any
 * match rejects a tracked-file removal authorization: a deleted credential
 * file is exactly the artifact a recovery must never be granted for.
 */
const GIT_RM_CREDENTIAL_NAME =
  /^(?:\.env(?:\.[^.]+)?|\.(?:npmrc|netrc|pypirc)|credentials(?:\.[^.]+)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|(?:.*\.)?(?:pem|key)|.*(?:secret|token|password|credential|apikey).*)$/i;

/** One path segment: no shell metacharacters, whitespace, quotes, or escapes. */
const GIT_RM_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+-]*$|^\.[A-Za-z0-9_][A-Za-z0-9._+-]*$/;

function assertSafeGitRmPathSyntax(requested: string): void {
  if (typeof requested !== 'string' || requested.length === 0) {
    throw new Error('Tracked-file removal paths must be non-empty strings');
  }
  if (path.isAbsolute(requested) || requested.startsWith('/') || requested.includes('\\') || requested.startsWith('~')) {
    throw new Error(`Tracked-file removal path must be worktree-relative: ${requested}`);
  }
  const segments = requested.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Tracked-file removal path contains traversal or empty segments: ${requested}`);
  }
  if (segments.some((segment) => !GIT_RM_SEGMENT.test(segment))) {
    throw new Error(`Tracked-file removal path contains shell metacharacters or unsafe characters: ${requested}`);
  }
  const basename = segments[segments.length - 1] as string;
  if (GIT_RM_CREDENTIAL_NAME.test(basename)) {
    throw new Error(`Tracked-file removal path looks credential-bearing: ${requested}`);
  }
}

function isProtectedGitRmPath(requested: string, protectedPaths: string[]): boolean {
  return protectedPaths.some((protectedPath) =>
    protectedPath.endsWith('/') ? requested.startsWith(protectedPath) : requested === protectedPath || requested.startsWith(protectedPath),
  );
}

/**
 * Validate a recovery authorization's tracked-file removal paths against the
 * exact failed task worktree. Every path must be a worktree-relative,
 * tracked, regular-file path free of traversal, shell metacharacters,
 * symlinks (in any ancestor segment), credential names, and configured
 * protected paths. Returns the validated paths or throws with the first
 * violation; no partial authorization is possible.
 */
export async function validateAuthorizedGitRmPaths(
  worktree: string,
  requested: string[],
  protectedPaths: string[],
): Promise<string[]> {
  if (!Array.isArray(requested) || requested.length === 0 || requested.length > GIT_RM_MAX_PATHS) {
    throw new Error(`Tracked-file removal requires 1-${GIT_RM_MAX_PATHS} paths`);
  }
  if (new Set(requested).size !== requested.length) {
    throw new Error('Tracked-file removal paths must not contain duplicates');
  }
  for (const candidate of requested) assertSafeGitRmPathSyntax(candidate);
  const root = path.resolve(worktree);
  for (const candidate of requested) {
    if (isProtectedGitRmPath(candidate, protectedPaths)) {
      throw new Error(`Tracked-file removal path is protected: ${candidate}`);
    }
    const absolute = path.resolve(root, candidate);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
      throw new Error(`Tracked-file removal path escapes the task worktree: ${candidate}`);
    }
    // Reject symlinks in any ancestor segment, not only the final path.
    let ancestor = root;
    for (const segment of candidate.split('/')) {
      ancestor = path.join(ancestor, segment);
      const link = lstatSync(ancestor, { throwIfNoEntry: false });
      if (link === undefined) throw new Error(`Tracked-file removal path is missing in the task worktree: ${candidate}`);
      if (link.isSymbolicLink()) throw new Error(`Tracked-file removal path traverses a symlink: ${candidate}`);
    }
    if (!statSync(absolute).isFile()) {
      throw new Error(`Tracked-file removal path is not a regular file: ${candidate}`);
    }
    const tracked = await runProcess({
      command: 'git',
      args: ['ls-files', '--', candidate],
      cwd: root,
      timeoutMs: 20_000,
    });
    if (tracked.exitCode !== 0 || !tracked.stdout.trim().split('\n').includes(candidate)) {
      throw new Error(`Tracked-file removal path is not tracked in the task worktree: ${candidate}`);
    }
  }
  return [...requested];
}

export function failureFingerprint(error: string): string {
  const normalized = error
    .toLowerCase()
    .replace(/(?:[a-z]:)?[\\/][^\s:]+/g, '<path>')
    .replace(/\b[0-9a-f]{7,64}\b/g, '<sha>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(normalized).digest('hex');
}

function rowToTask(row: TaskRow): TaskRecord {
  const parsed = JSON.parse(row.data) as TaskRecord;
  return {
    ...parsed,
    spec: parsed.spec
      ? {
          ...parsed.spec,
          technologyDecisions: parsed.spec.technologyDecisions ?? [],
          deploymentDecisions: parsed.spec.deploymentDecisions ?? [],
        }
      : null,
    state: row.state,
    continuations: parsed.continuations ?? 0,
    qwenAutomaticStop: parsed.qwenAutomaticStop ?? null,
    waitKind: parsed.waitKind ?? null,
    resumeAfter: parsed.resumeAfter ?? null,
    failureLineageId: parsed.failureLineageId ?? null,
    lineageFailures: parsed.lineageFailures ?? parsed.attempts ?? 0,
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    leaseExpiresAt: row.lease_expires_at,
    version: row.version,
  };
}

function rowToPortfolioPlan(row: PortfolioPlanRow): PortfolioPlan {
  const parsed = JSON.parse(row.data) as PortfolioPlan;
  return {
    ...parsed,
    technologyDecisions: parsed.technologyDecisions ?? [],
    deploymentDecisions: parsed.deploymentDecisions ?? [],
    stories: parsed.stories.map((story) => ({
      ...story,
      technologyDecisionIds: story.technologyDecisionIds ?? [],
      deploymentDecisionIds: story.deploymentDecisionIds ?? [],
    })),
    projectId: row.project_id,
    sourcePath: row.source_path,
    contentHash: row.content_hash,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

function eventRowToEvent(row: Record<string, unknown>): HarnessEvent {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    taskId: row.task_id === null ? null : String(row.task_id),
    type: String(row.type),
    idempotencyKey: row.idempotency_key === null ? null : String(row.idempotency_key),
    payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
    createdAt: Number(row.created_at),
  };
}

function sourceIssueNumber(value: string | undefined): number | null {
  if (!value) return null;
  try {
    const match = /\/issues\/(\d+)(?:\/|$)/.exec(new URL(value).pathname);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}
