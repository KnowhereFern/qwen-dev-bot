import { describe, expect, it } from 'vitest';
import { defaultProjectConfig } from '../src/core/config.js';
import { PersistentTaskStore } from '../src/core/persistent-store.js';
import { EvolutionSignalCollector } from '../src/evolution/signals.js';
import type { RewardScorecard } from '../src/core/types.js';
import type { GitHubControl } from '../src/github/control-plane.js';
import type { PortfolioPlanningModel } from '../src/portfolio/planner.js';
import { makeTmp } from './helpers.js';

const noIssues = { listOpenIssues: async () => [] } as unknown as GitHubControl;

function modelStub(relevant: boolean, material: boolean): PortfolioPlanningModel {
  return {
    completeJson: async <T>() => ({ value: {
      relevant, material, title: 'Review finding', summary: 'Concrete nonblocking finding.',
    } as T }),
  } satisfies PortfolioPlanningModel;
}

function reviewScorecard(id: string, taskId: string, commitSha: string, reason: string, passed = true, criterionPassed = true): RewardScorecard {
  return {
    id,
    taskId,
    projectId: 'signals-review',
    commitSha,
    evaluatorVersion: 'test',
    hardGatePass: true,
    aggregateScore: 0.9,
    aggregateThreshold: 0.8,
    passed,
    criteria: [
      { id: 'independent-review', modality: 'agentic', score: criterionPassed ? 0.9 : 0.5, threshold: 0.7, hard: false, critical: true, passed: criterionPassed, confidence: 0.9, reason, evidenceIds: [] },
    ],
    evidence: [],
    blockingReasons: [],
    createdAt: 1_700_000_000_000,
  };
}

function seedDoneTask(store: PersistentTaskStore, issueNumber: number, commitSha: string): string {
  const task = store.upsert({ issueNumber, title: `Task ${issueNumber}`, state: 'done' });
  store.patch(task.id, { commitSha, mergeSha: commitSha });
  return task.id;
}

describe('EvolutionSignalCollector', () => {
  it('deduplicates accepted non-material feedback by source and content', async () => {
    const root = makeTmp('signals-root');
    const config = defaultProjectConfig(root, 'fixture', 'owner/fixture');
    const store = new PersistentTaskStore('signals-fixture', makeTmp('signals-state'));
    const github = {
      listOpenIssues: async () => [{
        number: 7, title: 'Checkout regression', body: 'PIN confirmation fails after refresh.', labels: ['bug', 'harness:accept'],
        author: 'owner', url: 'https://github.com/owner/fixture/issues/7',
      }],
    } as unknown as GitHubControl;
    const model = {
      completeJson: async <T>() => ({ value: {
        relevant: true, material: false, title: 'Repair PIN confirmation', summary: 'Reproduce and repair the refresh regression.',
      } as T }),
    } satisfies PortfolioPlanningModel;
    const collector = new EvolutionSignalCollector(config, store, github, model);

    expect(await collector.scan(true)).toMatchObject({ observed: 1, accepted: 1, deduplicated: 0 });
    expect(await collector.scan(true)).toMatchObject({ observed: 0, accepted: 0, deduplicated: 1 });
    expect(store.listSignals()).toHaveLength(1);
    expect(store.listSignals()[0]?.status).toBe('accepted');
    store.close();
  });

  it('keeps material feedback as a proposal until explicitly accepted', async () => {
    const config = defaultProjectConfig(makeTmp('signals-material-root'), 'fixture', 'owner/fixture');
    const store = new PersistentTaskStore('signals-material', makeTmp('signals-material-state'));
    const github = {
      listOpenIssues: async () => [{
        number: 8, title: 'Move payment provider', body: 'Replace the approved payment provider.', labels: ['feedback'],
        author: 'owner', url: 'https://github.com/owner/fixture/issues/8',
      }],
    } as unknown as GitHubControl;
    const model = {
      completeJson: async <T>() => ({ value: {
        relevant: true, material: true, title: 'Payment provider change', summary: 'Changes approved technology.',
      } as T }),
    } satisfies PortfolioPlanningModel;
    const collector = new EvolutionSignalCollector(config, store, github, model);
    await collector.scan(true);
    const proposal = store.listSignals()[0]!;
    expect(proposal.status).toBe('proposed');
    expect(collector.decide(proposal.id, true).status).toBe('accepted');
    store.close();
  });

  it('ignores scorecard review findings unless reviewFindings is explicitly enabled', async () => {
    const config = defaultProjectConfig(makeTmp('signals-review-off-root'), 'fixture', 'owner/fixture');
    const store = new PersistentTaskStore('signals-review-off', makeTmp('signals-review-off-state'));
    const taskId = seedDoneTask(store, 11, 'a'.repeat(40));
    store.saveScorecard(reviewScorecard('sc_1', taskId, 'b'.repeat(40),
      'Independent review passed. Non-blocking issues only: src/app.ts:42 leaks a listener on unmount.'));
    const collector = new EvolutionSignalCollector(config, store, noIssues, modelStub(true, false));

    expect(config.evolution.reviewFindings).toBe(false);
    expect(await collector.scan(true)).toMatchObject({ observed: 0, accepted: 0, deduplicated: 0 });
    expect(store.listSignals()).toHaveLength(0);
    store.close();
  });

  it('accepts a concrete marked review finding with scorecard provenance', async () => {
    const config = defaultProjectConfig(makeTmp('signals-review-on-root'), 'fixture', 'owner/fixture');
    config.evolution.reviewFindings = true;
    const store = new PersistentTaskStore('signals-review-on', makeTmp('signals-review-on-state'));
    const taskId = seedDoneTask(store, 12, 'c'.repeat(40));
    const commitSha = 'c'.repeat(40);
    store.saveScorecard(reviewScorecard('sc_2', taskId, commitSha,
      'Independent review passed. NON-BLOCKING ISSUES ONLY: src/app.ts:42 leaks a listener on unmount; src/lib/util.ts:7 duplicates a helper.'));
    const collector = new EvolutionSignalCollector(config, store, noIssues, modelStub(true, false));

    expect(await collector.scan(true)).toMatchObject({ observed: 1, accepted: 1, proposed: 0 });
    const signal = store.listSignals()[0]!;
    expect(signal.source).toBe('review');
    expect(signal.status).toBe('accepted');
    expect(signal.evidence[0]?.locator).toBe('sc_2');
    expect(signal.evidence[0]?.commitSha).toBe(commitSha);
    expect(signal.sourceKey).toContain(taskId);
    expect(signal.sourceKey).toContain(commitSha);
    store.close();
  });

  it('deduplicates repeated scans and repeat evaluations of the same finding text', async () => {
    const config = defaultProjectConfig(makeTmp('signals-review-dup-root'), 'fixture', 'owner/fixture');
    config.evolution.reviewFindings = true;
    const store = new PersistentTaskStore('signals-review-dup', makeTmp('signals-review-dup-state'));
    const taskId = seedDoneTask(store, 13, 'e'.repeat(40));
    const commitSha = 'e'.repeat(40);
    const reason = 'Independent review passed. Non-blocking issues only: src/app.ts:42 leaks a listener on unmount.';
    store.saveScorecard(reviewScorecard('sc_3', taskId, commitSha, reason));
    store.saveScorecard(reviewScorecard('sc_4', taskId, commitSha, reason));
    const collector = new EvolutionSignalCollector(config, store, noIssues, modelStub(true, false));

    expect(await collector.scan(true)).toMatchObject({ observed: 1, accepted: 1, deduplicated: 1 });
    expect(await collector.scan(true)).toMatchObject({ observed: 0, deduplicated: 2 });
    expect(store.listSignals()).toHaveLength(1);
    store.close();
  });

  it('rejects review prose without the marker, without a file citation, or from failing scorecards', async () => {
    const config = defaultProjectConfig(makeTmp('signals-review-vague-root'), 'fixture', 'owner/fixture');
    config.evolution.reviewFindings = true;
    const store = new PersistentTaskStore('signals-review-vague', makeTmp('signals-review-vague-state'));
    const noMarker = seedDoneTask(store, 14, '1'.repeat(40));
    const noCitation = seedDoneTask(store, 15, '2'.repeat(40));
    const failed = seedDoneTask(store, 16, '3'.repeat(40));
    store.saveScorecard(reviewScorecard('sc_5', noMarker, '1'.repeat(40),
      'src/app.ts:42 could be tidier but overall fine.'));
    store.saveScorecard(reviewScorecard('sc_6', noCitation, '2'.repeat(40),
      'Non-blocking issues only: the error handling could be more consistent.'));
    store.saveScorecard(reviewScorecard('sc_7', failed, '3'.repeat(40),
      'Non-blocking issues only: src/app.ts:42 leaks a listener on unmount.', false));
    const collector = new EvolutionSignalCollector(config, store, noIssues, modelStub(true, false));

    expect(await collector.scan(true)).toMatchObject({ observed: 0, accepted: 0, proposed: 0 });
    expect(store.listSignals()).toHaveLength(0);
    store.close();
  });

  it('keeps material review findings as proposals pending explicit approval', async () => {
    const config = defaultProjectConfig(makeTmp('signals-review-material-root'), 'fixture', 'owner/fixture');
    config.evolution.reviewFindings = true;
    const store = new PersistentTaskStore('signals-review-material', makeTmp('signals-review-material-state'));
    const taskId = seedDoneTask(store, 17, '7'.repeat(40));
    store.saveScorecard(reviewScorecard('sc_8', taskId, '7'.repeat(40),
      'Independent review passed. Non-blocking issues only: src/app.ts:42 suggests replacing the approved database technology.'));
    const collector = new EvolutionSignalCollector(config, store, noIssues, modelStub(true, true));

    expect(await collector.scan(true)).toMatchObject({ observed: 1, proposed: 1, accepted: 0 });
    const proposal = store.listSignals()[0]!;
    expect(proposal.status).toBe('proposed');
    expect(collector.decide(proposal.id, true).status).toBe('accepted');
    store.close();
  });

  it('rejects a stale passed scorecard from an earlier candidate commit and accepts the final candidate scorecard', async () => {
    const config = defaultProjectConfig(makeTmp('signals-review-stale-root'), 'fixture', 'owner/fixture');
    config.evolution.reviewFindings = true;
    const store = new PersistentTaskStore('signals-review-stale', makeTmp('signals-review-stale-state'));
    const finalCommit = '9'.repeat(40);
    const staleCommit = 'a1b2c3d4e5'.repeat(4);
    const taskId = seedDoneTask(store, 18, finalCommit);
    store.saveScorecard(reviewScorecard('sc_stale', taskId, staleCommit,
      'Independent review passed. Non-blocking issues only: src/old.ts:11 stale finding that no longer applies.'));
    store.saveScorecard(reviewScorecard('sc_final', taskId, finalCommit,
      'Independent review passed. Non-blocking issues only: src/app.ts:42 leaks a listener on unmount.'));
    const collector = new EvolutionSignalCollector(config, store, noIssues, modelStub(true, false));

    expect(await collector.scan(true)).toMatchObject({ observed: 1, accepted: 1, proposed: 0, rejected: 0 });
    const signals = store.listSignals();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.evidence[0]?.locator).toBe('sc_final');
    expect(signals[0]!.evidence[0]?.commitSha).toBe(finalCommit);
    store.close();
  });

  it('rejects findings from an independent-review criterion that did not pass even on a passing final-commit scorecard', async () => {
    const config = defaultProjectConfig(makeTmp('signals-review-criterion-root'), 'fixture', 'owner/fixture');
    config.evolution.reviewFindings = true;
    const store = new PersistentTaskStore('signals-review-criterion', makeTmp('signals-review-criterion-state'));
    const finalCommit = 'b'.repeat(40);
    const taskId = seedDoneTask(store, 19, finalCommit);
    store.saveScorecard(reviewScorecard('sc_criterion', taskId, finalCommit,
      'Non-blocking issues only: src/app.ts:42 leaks a listener on unmount.', true, false));
    const collector = new EvolutionSignalCollector(config, store, noIssues, modelStub(true, false));

    expect(await collector.scan(true)).toMatchObject({ observed: 0, accepted: 0, proposed: 0, rejected: 0 });
    expect(store.listSignals()).toHaveLength(0);
    store.close();
  });
});
