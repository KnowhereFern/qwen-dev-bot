import { describe, expect, it } from 'vitest';
import { PersistentTaskStore } from '../src/core/persistent-store.js';
import type { PortfolioPlan, TaskSpec } from '../src/core/types.js';
import { buildEvidenceReport } from '../src/program/evidence-report.js';
import { makeTmp } from './helpers.js';

describe('program evidence report', () => {
  it('includes program tasks, staging repairs, metrics, and distinct elapsed/active time', () => {
    const store = new PersistentTaskStore('evidence-project', makeTmp('evidence-report'));
    const primary = store.upsert({ issueNumber: 10, title: 'primary', state: 'done', spec: spec('https://github.test/issues/1') });
    const repair = store.upsert({ issueNumber: 20, title: 'staging repair', state: 'done', spec: spec('https://github.test/issues/19') });
    store.recordEvent('staging.repair_created', null, { planId: 'plan_1', issueNumber: 19 });
    store.recordEvent('program.external_commit_observed', null, { planId: 'plan_1', commitSha: 'b'.repeat(40) });
    const plan: PortfolioPlan = {
      id: 'plan_1', projectId: store.projectId, sourcePath: 'PROJECT.md', contentHash: 'objective', sourceContent: 'Build it',
      title: 'Program', objective: 'Build it', constraints: [], definitionOfDone: ['Verified'], technologyDecisions: [], deploymentDecisions: [],
      status: 'maintaining', epicIssueNumber: 1, epicIssueUrl: 'https://github.test/issues/1',
      stories: [{
        key: 'S1', title: 'Primary', goal: 'Build', acceptanceCriteria: ['Done'], constraints: [], requiredGateIds: [], rewardCriterionIds: [],
        risk: 'low', dependsOn: [], rollback: 'Revert', technologyDecisionIds: [], deploymentDecisionIds: [], sourceIssueNumber: 2,
        sourceIssueUrl: 'https://github.test/issues/2', normalizedIssueNumber: 10, normalizedIssueUrl: 'https://github.test/issues/10',
      }],
      coverage: [{ id: 'REQ1', requirement: 'Build', status: 'implemented', requiredAction: 'none', rationale: 'Verified', evidence: [] }],
      createdAt: 1_000, updatedAt: 2_000, approvedAt: 1_100, deliveredAt: 2_000,
    };

    const report = buildEvidenceReport(store, plan, 3_000);
    expect(report.tasks.map((task) => task.id)).toEqual(expect.arrayContaining([primary.id, repair.id]));
    expect(report.metrics).toMatchObject({ verifiedCapabilities: 1, interventionCount: 1, elapsedMs: 1_000 });
    expect(report.metrics.waitingMs).toBe(report.metrics.elapsedMs - report.metrics.activeMs);
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
