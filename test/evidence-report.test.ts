import { describe, expect, it } from 'vitest';
import { PersistentTaskStore } from '../src/core/persistent-store.js';
import type { PortfolioPlan, TaskSpec } from '../src/core/types.js';
import { buildEvidenceReport, formatEvidenceReport } from '../src/program/evidence-report.js';
import { makeTmp } from './helpers.js';

describe('program evidence report', () => {
  it('includes program tasks, staging repairs, metrics, and distinct elapsed/active time', () => {
    const store = new PersistentTaskStore('evidence-project', makeTmp('evidence-report'));
    const primary = store.upsert({ issueNumber: 10, title: 'primary', state: 'done', spec: spec('https://github.test/issues/1') });
    const repair = store.upsert({ issueNumber: 20, title: 'staging repair', state: 'done', spec: spec('https://github.test/issues/19') });
    store.recordEvent('staging.repair_created', null, { planId: 'plan_1', issueNumber: 19 });
    store.recordEvent('program.external_commit_observed', null, { planId: 'plan_1', commitSha: 'b'.repeat(40) });
    store.recordEvent('program.manual_intervention_observed', null, { planId: 'plan_1', autonomousDeliveryCredit: false });
    store.recordEvent('task.recovery_authorized', primary.id, { additionalAttempts: 3 });
    store.recordEvent('program.manual_intervention_observed', null, { planId: 'unrelated_plan' });
    const unrelated = store.upsert({ issueNumber: 30, title: 'unrelated', state: 'failed', spec: spec('https://github.test/issues/99') });
    store.recordEvent('task.recovery_authorized', unrelated.id, { additionalAttempts: 3 });
    const legacy = store.upsert({ issueNumber: 40, title: 'legacy done', state: 'done' });
    const failedGates = [{ id: 'unit', kind: 'unit', required: true, applicable: true, ok: false, exitCode: 1, durationMs: 4, evidenceHash: 'hash-unit-fail' }];
    const passedGates = [
      { id: 'unit', kind: 'unit', required: true, applicable: true, ok: true, exitCode: 0, durationMs: 5, evidenceHash: 'hash-unit-pass' },
      { id: 'security', kind: 'security', required: true, applicable: true, ok: true, exitCode: 0, durationMs: 6, evidenceHash: 'hash-security' },
      { id: 'lint', kind: 'lint', required: false, applicable: true, ok: true, exitCode: 0, durationMs: 2, evidenceHash: 'hash-lint-optional' },
      { id: 'smoke', kind: 'smoke', required: true, applicable: false, ok: false, exitCode: null, durationMs: 0, evidenceHash: 'hash-smoke-skipped' },
    ];
    const postMerge = (runId: string, mergeSha: string, passed: boolean, gates: Array<Record<string, unknown>>) =>
      store.recordEvent('postmerge.verification', primary.id, { runId, mergeSha, startedAt: 1_500, finishedAt: 1_600, passed, sideEffectFailure: false, gates });
    postMerge('run-fail-1', 'a'.repeat(40), false, failedGates);
    postMerge('run-fail-2', 'a'.repeat(40), false, failedGates);
    postMerge('run-pass', 'b'.repeat(40), true, passedGates);
    const malformed = (overrides: Record<string, unknown>) =>
      store.recordEvent('postmerge.verification', primary.id, {
        runId: 'run-malformed', mergeSha: 'd'.repeat(40), startedAt: 1_700, finishedAt: 1_800,
        passed: true, sideEffectFailure: false, gates: [], ...overrides,
      });
    malformed({ runId: '' });
    malformed({ runId: 'run-short-sha', mergeSha: 'abc123' });
    malformed({ runId: 'run-epoch-times', startedAt: 0, finishedAt: 0 });
    malformed({ runId: 'run-reversed-times', startedAt: 1_900 });
    malformed({ runId: 'run-string-passed', passed: 'true' });
    malformed({ runId: 'run-missing-gates', gates: undefined });
    store.recordEvent('postmerge.verification', unrelated.id, { runId: 'run-outsider', mergeSha: 'c'.repeat(40), startedAt: 1_000, finishedAt: 1_100, passed: true, sideEffectFailure: false, gates: [] });
    store.recordEvent('controller.promoted', null, { version: 'fixture-release' });
    const plan: PortfolioPlan = {
      id: 'plan_1', projectId: store.projectId, sourcePath: 'PROJECT.md', contentHash: 'objective', sourceContent: 'Build it',
      title: 'Program', objective: 'Build it', constraints: [], definitionOfDone: ['Verified'], technologyDecisions: [], deploymentDecisions: [],
      status: 'maintaining', epicIssueNumber: 1, epicIssueUrl: 'https://github.test/issues/1',
      stories: [{
        key: 'S1', title: 'Primary', goal: 'Build', acceptanceCriteria: ['Done'], constraints: [], requiredGateIds: [], rewardCriterionIds: [],
        risk: 'low', dependsOn: [], rollback: 'Revert', technologyDecisionIds: [], deploymentDecisionIds: [], sourceIssueNumber: 2,
        sourceIssueUrl: 'https://github.test/issues/2', normalizedIssueNumber: 10, normalizedIssueUrl: 'https://github.test/issues/10',
      }, {
        key: 'S2', title: 'Legacy', goal: 'Legacy delivery', acceptanceCriteria: ['Done'], constraints: [], requiredGateIds: [], rewardCriterionIds: [],
        risk: 'low', dependsOn: [], rollback: 'Revert', technologyDecisionIds: [], deploymentDecisionIds: [], sourceIssueNumber: 41,
        sourceIssueUrl: 'https://github.test/issues/41', normalizedIssueNumber: 40, normalizedIssueUrl: 'https://github.test/issues/40',
      }],
      coverage: [{ id: 'REQ1', requirement: 'Build', status: 'implemented', requiredAction: 'none', rationale: 'Verified', evidence: [] }],
      createdAt: 1_000, updatedAt: 2_000, approvedAt: 1_100, deliveredAt: 2_000,
    };

    const before = store.list();
    const report = buildEvidenceReport(store, plan, 3_000);
    expect(store.list()).toEqual(before);
    expect(report.tasks.map((task) => task.id)).toEqual(expect.arrayContaining([primary.id, repair.id]));
    expect(report.metrics).toMatchObject({ verifiedCapabilities: 1, interventionCount: 4, elapsedMs: 1_000 });
    expect(report.interventions.map((event) => event.type)).toEqual([
      'program.external_commit_observed', 'program.manual_intervention_observed', 'task.recovery_authorized', 'controller.promoted',
    ]);
    expect(report.interventions[1]?.payload.autonomousDeliveryCredit).toBe(false);
    expect(report.metrics.waitingMs).toBe(report.metrics.elapsedMs - report.metrics.activeMs);
    const records = report.postMergeVerifications;
    expect(records.map((entry) => entry.runId)).toEqual(['run-fail-1', 'run-fail-2', 'run-pass']);
    for (const runId of ['', 'run-short-sha', 'run-epoch-times', 'run-reversed-times', 'run-string-passed', 'run-missing-gates']) {
      expect(records.some((entry) => entry.runId === runId)).toBe(false);
    }
    expect(records.every((entry) => entry.runId.trim() !== '' && /^[0-9a-f]{40}$/i.test(entry.mergeSha))).toBe(true);
    expect(records.every((entry) => entry.startedAt > 0 && entry.finishedAt >= entry.startedAt)).toBe(true);
    expect(records.every((entry) => entry.taskId === primary.id)).toBe(true);
    expect(records.map((entry) => entry.mergeSha)).toEqual(['a'.repeat(40), 'a'.repeat(40), 'b'.repeat(40)]);
    expect(records.map((entry) => entry.passed)).toEqual([false, false, true]);
    expect(records.map((entry) => entry.startedAt)).toEqual([1_500, 1_500, 1_500]);
    expect(records.map((entry) => entry.finishedAt)).toEqual([1_600, 1_600, 1_600]);
    for (const entry of records) {
      for (const gate of entry.gates) {
        expect(Object.keys(gate).sort()).toEqual(['applicable', 'durationMs', 'evidenceHash', 'exitCode', 'id', 'kind', 'ok', 'required']);
      }
    }
    expect(records[2]?.gates.map((gate) => gate.evidenceHash)).toEqual(['hash-unit-pass', 'hash-security', 'hash-lint-optional', 'hash-smoke-skipped']);
    expect(records.some((entry) => entry.taskId === legacy.id)).toBe(false);
    expect(report.tasks.map((task) => task.id)).toContain(legacy.id);
    expect(records.some((entry) => entry.runId === 'run-outsider')).toBe(false);
    const markdown = formatEvidenceReport(report);
    for (const runId of ['run-fail-1', 'run-fail-2', 'run-pass']) expect(markdown).toContain(`run=${runId}:`);
    for (const runId of ['run-short-sha', 'run-epoch-times', 'run-reversed-times', 'run-string-passed', 'run-missing-gates']) {
      expect(markdown).not.toContain(`run=${runId}:`);
    }
    expect(markdown).toContain(`task=${primary.id};`);
    expect(markdown).toContain('passed=false');
    expect(markdown).toContain('passed=true');
    expect(markdown).toContain('unit=fail@hash-unit-fail');
    expect(markdown).toContain('unit=ok@hash-unit-pass');
    expect(markdown).toContain('security=ok@hash-security');
    expect(markdown).toContain('lint=ok@hash-lint-optional (optional)');
    expect(markdown).toContain('smoke=fail@hash-smoke-skipped (skipped-required)');
    expect(markdown).toContain('not current acceptance authority');
    store.close();
  });
});

function spec(url: string): TaskSpec {
  return {
    goal: 'Deliver', source: { kind: 'self-repair', url }, acceptanceCriteria: ['Done'], constraints: [],
    requiredGateIds: [], rewardCriterionIds: [], risk: 'low', dependencies: [], rollback: 'Revert',
    technologyDecisions: [], deploymentDecisions: [],
  };
}
