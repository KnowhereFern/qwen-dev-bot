import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { PersistentTaskStore } from '../core/persistent-store.js';
import { harnessStateRoot } from '../core/state-paths.js';
import type { ControllerRelease, PortfolioPlan } from '../core/types.js';

export interface ProgramEvidenceReport {
  generatedAt: number;
  plan: {
    id: string;
    title: string;
    objective: string;
    status: PortfolioPlan['status'];
    sourcePath: string;
    sourceHash: string;
    startingRepositorySha: string | null;
    currentRepositorySha: string | null;
    createdAt: number;
    deliveredAt: number | null;
    elapsedMs: number;
    activeTaskMs: number;
  };
  interventions: Array<{ type: string; createdAt: number; payload: Record<string, unknown> }>;
  metrics: {
    verifiedCapabilities: number;
    regressions: number;
    repairsSucceeded: number;
    interventionCount: number;
    elapsedMs: number;
    activeMs: number;
    waitingMs: number;
  };
  revisions: PortfolioPlan['revisions'];
  coverage: PortfolioPlan['coverage'];
  tasks: Array<{
    id: string;
    issueNumber: number;
    state: string;
    attempts: number;
    commitSha: string | null;
    prNumber: number | null;
    mergeSha: string | null;
    rewardRunId: string | null;
  }>;
  scorecards: ReturnType<PersistentTaskStore['listScorecards']>;
  deployments: ReturnType<PersistentTaskStore['listDeployments']>;
  signals: ReturnType<PersistentTaskStore['listSignals']>;
  controllerReleases: ReturnType<PersistentTaskStore['listControllerReleases']>;
  postMergeVerifications: Array<{
    eventId: string;
    taskId: string;
    runId: string;
    mergeSha: string;
    startedAt: number;
    finishedAt: number;
    passed: boolean;
    sideEffectFailure: boolean;
    gates: Array<{
      id: string;
      kind: string;
      required: boolean;
      applicable: boolean;
      ok: boolean;
      exitCode: number | null;
      durationMs: number;
      evidenceHash: string;
    }>;
  }>;
}

export function buildEvidenceReport(store: PersistentTaskStore, plan: PortfolioPlan, now = Date.now()): ProgramEvidenceReport {
  const tasks = store.list();
  const taskIds = new Set(plan.stories.flatMap((story) =>
    story.normalizedIssueNumber === null ? [] : tasks.filter((task) => task.issueNumber === story.normalizedIssueNumber).map((task) => task.id),
  ));
  const events = store.listEvents();
  const stagingRepairIssues = new Set(events
    .filter((event) => ['staging.repair_created', 'staging.repair_reused'].includes(event.type) && event.payload.planId === plan.id)
    .map((event) => Number(event.payload.issueNumber))
    .filter(Number.isSafeInteger));
  for (const task of tasks) {
    const sourceIssue = sourceIssueNumber(task.spec?.source.url);
    if (sourceIssue !== null && stagingRepairIssues.has(sourceIssue)) taskIds.add(task.id);
  }
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const task of tasks) {
      if (!taskIds.has(task.id) && task.failureLineageId && taskIds.has(task.failureLineageId)) {
        taskIds.add(task.id);
        expanded = true;
      }
    }
  }
  const planTasks = tasks.filter((task) => taskIds.has(task.id));
  const interventions = events.filter((event) =>
    [
      'program.approved',
      'portfolio.redrafted',
      'program.external_commit_observed',
      'program.manual_intervention_observed',
      'task.recovery_authorized',
      'program.revised',
      'program.objective_accepted',
      'evolution.signal_decided',
      'controller.promoted',
      'controller.rolled_back',
    ].includes(event.type) &&
    (event.payload.planId === undefined || event.payload.planId === plan.id) &&
    (event.taskId === null || taskIds.has(event.taskId)),
  );
  const controllerReleases = mergeControllerHistory(store.listControllerReleases(), readGlobalControllerHistory());
  const elapsedMs = Math.max(0, (plan.deliveredAt ?? now) - plan.createdAt);
  const activeMs = activeDuration(events, taskIds);
  return {
    generatedAt: now,
    plan: {
      id: plan.id,
      title: plan.title,
      objective: plan.objective,
      status: plan.status,
      sourcePath: plan.sourcePath,
      sourceHash: plan.contentHash,
      startingRepositorySha: plan.revisions?.[0]?.repositorySha ?? plan.repositorySha ?? null,
      currentRepositorySha: plan.repositorySha ?? null,
      createdAt: plan.createdAt,
      deliveredAt: plan.deliveredAt ?? null,
      elapsedMs,
      activeTaskMs: activeMs,
    },
    interventions: interventions.map((event) => ({ type: event.type, createdAt: event.createdAt, payload: event.payload })),
    metrics: {
      verifiedCapabilities: (plan.coverage ?? []).filter((entry) => entry.status === 'implemented').length,
      regressions: store.listDeployments(plan.id).filter((deployment) => ['failed', 'rolled_back'].includes(deployment.status)).length +
        events.filter((event) => event.type === 'postmerge.repair_created' && event.taskId && taskIds.has(event.taskId)).length,
      repairsSucceeded: planTasks.filter((task) => task.failureLineageId && task.state === 'done').length,
      interventionCount: interventions.length,
      elapsedMs,
      activeMs,
      waitingMs: Math.max(0, elapsedMs - activeMs),
    },
    revisions: structuredClone(plan.revisions ?? []),
    coverage: structuredClone(plan.coverage ?? []),
    tasks: planTasks.map((task) => ({
      id: task.id,
      issueNumber: task.issueNumber,
      state: task.state,
      attempts: task.attempts,
      commitSha: task.commitSha,
      prNumber: task.prNumber,
      mergeSha: task.mergeSha,
      rewardRunId: task.rewardRunId,
    })),
    scorecards: store.listScorecards().filter((scorecard) => taskIds.has(scorecard.taskId)),
    deployments: store.listDeployments(plan.id),
    signals: store.listSignals(),
    controllerReleases,
    postMergeVerifications: postMergeVerificationRecords(events, taskIds),
  };
}

export function formatEvidenceReport(report: ProgramEvidenceReport): string {
  const coverageCounts = count(report.coverage ?? [], (entry) => entry.status);
  const taskCounts = count(report.tasks, (task) => task.state);
  return [
    `# ${report.plan.title} — autonomous delivery evidence`,
    '',
    `- Plan: \`${report.plan.id}\` (${report.plan.status})`,
    `- Objective source: \`${report.plan.sourcePath}\` / \`${report.plan.sourceHash}\``,
    `- Repository: \`${report.plan.startingRepositorySha ?? 'unknown'}\` → \`${report.plan.currentRepositorySha ?? 'unknown'}\``,
    `- Elapsed: ${report.plan.elapsedMs} ms; recorded task time: ${report.plan.activeTaskMs} ms`,
    `- Waiting/observation: ${report.metrics.waitingMs} ms; interventions: ${report.metrics.interventionCount}`,
    `- Verified capabilities: ${report.metrics.verifiedCapabilities}; regressions: ${report.metrics.regressions}; successful repairs: ${report.metrics.repairsSucceeded}`,
    `- Task states: ${JSON.stringify(taskCounts)}`,
    `- Coverage: ${JSON.stringify(coverageCounts)}`,
    `- Deployments: ${report.deployments.length}; signals: ${report.signals.length}; controller releases: ${report.controllerReleases.length}`,
    '',
    '## Objective',
    '',
    report.plan.objective,
    '',
    '## Coverage',
    '',
    ...(report.coverage?.map((entry) => `- **${entry.status}** \`${entry.id}\` ${entry.requirement} — ${entry.rationale}`) ?? ['- None']),
    '',
    '## Delivery records',
    '',
    ...report.tasks.map((task) => `- Issue #${task.issueNumber}: ${task.state}; attempts=${task.attempts}; PR=${task.prNumber ?? '-'}; merge=${task.mergeSha ?? '-'}`),
    '',
    '## Staging records',
    '',
    ...report.deployments.map((deployment) => `- ${deployment.id}: ${deployment.status}; commit=${deployment.commitSha}; observed=${deployment.observedRevision ?? '-'}`),
    '',
    '## Post-merge verification records',
    '',
    '> Historical post-merge checks captured at delivery time: they evidence which runs happened, and are not current acceptance authority.',
    '',
    ...(report.postMergeVerifications.length > 0
      ? report.postMergeVerifications.map((record) => `- ${new Date(record.finishedAt).toISOString()} run=${record.runId}: task=${record.taskId}; merge=${record.mergeSha}; passed=${record.passed}; sideEffectFailure=${record.sideEffectFailure}; gates=${record.gates.map(formatGate).join(', ') || 'none'}`)
      : ['- None recorded.']),
    '',
    '## Human and governance interventions',
    '',
    ...(report.interventions.length ? report.interventions.map((event) => `- ${new Date(event.createdAt).toISOString()} ${event.type}: ${JSON.stringify(event.payload)}`) : ['- None recorded.']),
  ].join('\n');
}

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/i;

type PostMergeVerificationGate = ProgramEvidenceReport['postMergeVerifications'][number]['gates'][number];

function formatGate(gate: PostMergeVerificationGate): string {
  const base = `${gate.id}=${gate.ok ? 'ok' : 'fail'}@${gate.evidenceHash}`;
  if (gate.applicable && gate.required) return base;
  if (!gate.applicable) return `${base} (${gate.required ? 'skipped-required' : 'skipped-optional'})`;
  return `${base} (optional)`;
}

function postMergeVerificationRecords(
  events: ReturnType<PersistentTaskStore['listEvents']>,
  taskIds: Set<string>,
): ProgramEvidenceReport['postMergeVerifications'] {
  const records: ProgramEvidenceReport['postMergeVerifications'] = [];
  for (const event of events) {
    if (event.type !== 'postmerge.verification') continue;
    const taskId = event.taskId;
    if (taskId === null || !taskIds.has(taskId)) continue;
    const record = parsePostMergeVerification(event.id, taskId, event.payload);
    if (record !== null) records.push(record);
  }
  return records;
}

function parsePostMergeVerification(
  eventId: string,
  taskId: string,
  rawPayload: unknown,
): ProgramEvidenceReport['postMergeVerifications'][number] | null {
  const payload = typeof rawPayload === 'object' && rawPayload !== null ? (rawPayload as Record<string, unknown>) : {};
  const { runId, mergeSha, startedAt, finishedAt, passed, sideEffectFailure, gates } = payload;
  if (typeof runId !== 'string' || runId.trim() === '') return null;
  if (typeof mergeSha !== 'string' || !FULL_COMMIT_SHA.test(mergeSha)) return null;
  if (!isPositiveTimestamp(startedAt) || !isPositiveTimestamp(finishedAt)) return null;
  if (finishedAt < startedAt) return null;
  if (typeof passed !== 'boolean' || !Array.isArray(gates)) return null;
  return {
    eventId,
    taskId,
    runId,
    mergeSha,
    startedAt,
    finishedAt,
    passed,
    sideEffectFailure: sideEffectFailure === true,
    gates: gates
      .filter((gate): gate is Record<string, unknown> => typeof gate === 'object' && gate !== null)
      .map((gate) => ({
        id: typeof gate.id === 'string' ? gate.id : '',
        kind: typeof gate.kind === 'string' ? gate.kind : '',
        required: gate.required === true,
        applicable: gate.applicable === true,
        ok: gate.ok === true,
        exitCode: typeof gate.exitCode === 'number' ? gate.exitCode : null,
        durationMs: typeof gate.durationMs === 'number' ? gate.durationMs : 0,
        evidenceHash: typeof gate.evidenceHash === 'string' ? gate.evidenceHash : '',
      })),
  };
}

function isPositiveTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function count<T>(values: T[], key: (value: T) => string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[key(value)] = (result[key(value)] ?? 0) + 1;
  return result;
}

function activeDuration(
  events: ReturnType<PersistentTaskStore['listEvents']>,
  taskIds: Set<string>,
): number {
  const started = new Map<string, number>();
  let total = 0;
  for (const event of events) {
    if (!event.taskId || !taskIds.has(event.taskId)) continue;
    if (event.type === 'task.active_started') {
      started.set(event.taskId, event.createdAt);
      continue;
    }
    if (['task.active_finished', 'task.execution_recovered', 'task.reconciliation_recovered'].includes(event.type)) {
      const since = started.get(event.taskId);
      if (since !== undefined) total += Math.max(0, event.createdAt - since);
      started.delete(event.taskId);
    }
  }
  return total;
}

function readGlobalControllerHistory(): ControllerRelease[] {
  const file = path.join(harnessStateRoot(), 'controller', 'release-history.json');
  if (!existsSync(file)) return [];
  const value = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (!Array.isArray(value)) throw new Error('Controller release history is invalid');
  return value as ControllerRelease[];
}

function mergeControllerHistory(...groups: ControllerRelease[][]): ControllerRelease[] {
  const releases = new Map<string, ControllerRelease>();
  for (const release of groups.flat()) {
    const existing = releases.get(release.id);
    if (!existing || existing.updatedAt <= release.updatedAt) releases.set(release.id, release);
  }
  return [...releases.values()].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

function sourceIssueNumber(url?: string): number | null {
  const value = /\/issues\/(\d+)(?:$|[?#])/.exec(url ?? '')?.[1];
  return value ? Number(value) : null;
}
