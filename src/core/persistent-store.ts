import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { EventLedger, redactForLedger, redactText } from './ledger.js';
import { assertTaskTransition, isTaskLeased } from './task-state.js';
import type {
  HarnessEvent,
  PortfolioPlan,
  PortfolioPlanStatus,
  RewardScorecard,
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
      identicalFailures: 0,
      lastFailureFingerprint: null,
      maxAttempts: input.maxAttempts ?? 5,
      leaseOwner: null,
      leaseExpiresAt: null,
      baseSha: null,
      branch: null,
      worktreePath: null,
      commitSha: null,
      qwenSessionId: null,
      qwenWorkflowRunId: null,
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
           WHERE project_id = ? AND state = 'ready' AND attempts < max_attempts
           ORDER BY priority ASC, issue_number ASC`,
        )
        .all(this.projectId) as unknown as TaskRow[];
      const dependencyTasks = (
        this.db.prepare('SELECT * FROM tasks WHERE project_id = ?').all(this.projectId) as unknown as TaskRow[]
      ).map(rowToTask);
      const row = rows.find((candidate) => this.dependenciesSatisfied(rowToTask(candidate), dependencyTasks));
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

  private dependenciesSatisfied(task: TaskRecord, candidates: TaskRecord[]): boolean {
    const dependencies = [...new Set(task.spec?.dependencies ?? [])];
    return dependencies.every((issueNumber) =>
      candidates.some(
        (candidate) =>
          candidate.state === 'done' &&
          (candidate.issueNumber === issueNumber || sourceIssueNumber(candidate.spec?.source.url) === issueNumber),
      ),
    );
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
    const to: TaskState =
      identicalFailures >= identicalLimit ? 'quarantined' : attempts >= task.maxAttempts ? 'failed' : 'ready';
    return this.transition(
      id,
      to,
      {
        attempts,
        identicalFailures,
        lastFailureFingerprint: fingerprint,
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
    const patch = {
      attempts,
      identicalFailures,
      lastFailureFingerprint: fingerprint,
      lastError: error,
      leaseOwner: null,
      leaseExpiresAt: null,
    };
    if (identicalFailures >= identicalLimit) return this.transition(id, 'quarantined', patch, now);
    if (attempts >= task.maxAttempts) return this.transition(id, 'failed', patch, now);
    const updated = this.patch(id, patch, now);
    this.recordEvent('postmerge.retry_scheduled', id, { attempts, identicalFailures });
    return updated;
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
    state: row.state,
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
