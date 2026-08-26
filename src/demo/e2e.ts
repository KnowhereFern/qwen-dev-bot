import { existsSync } from 'node:fs';
import path from 'node:path';
import { MockAgentExecutor } from '../agent/mock.js';
import { Dispatcher } from '../dispatcher.js';
import { MockGitHubAdapter } from '../github/mock.js';
import { Logger } from '../logger.js';
import { OrchestratorLoop } from '../loop.js';
import { Monitor } from '../monitor.js';
import { IssueStore } from '../store.js';
import { TestGate } from '../test-gate.js';
import { Watchdog } from '../watchdog.js';
import { createMockScripts, createWorkspace } from './workspace.js';

/**
 * End-to-end demo, fully mock mode (no credentials, no network):
 *
 *   1. seed one `feature` issue into the mock repo
 *   2. dispatcher claims it, mock agent implements it (with a seeded
 *      regression the unit gate cannot see), test gate passes, PR merged
 *   3. post-merge check fails on the seeded regression -> the monitor opens
 *      a linked `self-repair` issue
 *   4. the same loop claims the self-repair issue, the mock agent removes
 *      the regression, test gate passes, PR merged, post-merge checks pass
 *   5. the loop drains to all-done and exits 0
 *
 * Exit codes: 0 = scenario verified, 1 = verification failed, 2 = hard timeout.
 */
const workDir = path.join(process.cwd(), 'demo-workspace');
createWorkspace(workDir);

const logger = new Logger({ level: 'info' });
const adapter = new MockGitHubAdapter();
const store = new IssueStore({ maxAttempts: 3 });

const seed = await adapter.createIssue({
  title: 'Add greeting feature',
  body: 'Seed issue: implement the greeting feature.',
  labels: ['feature'],
});
store.add({ title: seed.title, body: seed.body, labels: seed.labels, issueNumber: seed.number });
logger.info('seeded issue', { issueNumber: seed.number, title: seed.title });

const executor = new MockAgentExecutor(createMockScripts());
const unitGate = new TestGate(process.execPath, ['check.mjs'], workDir, 15_000);
const postMergeGate = new TestGate(process.execPath, ['postmerge.mjs'], workDir, 15_000);

const monitor = new Monitor(adapter, store, postMergeGate, logger);
const dispatcher = new Dispatcher(
  store,
  adapter,
  executor,
  unitGate,
  {
    maxConcurrent: 2,
    leaseMs: 5_000,
    executionTimeoutMs: 30_000,
    workDir,
    baseBranch: 'main',
    onMerged: (merge) => monitor.enqueue(merge),
  },
  logger,
);
const watchdog = new Watchdog(store, logger);
const loop = new OrchestratorLoop(
  dispatcher,
  watchdog,
  monitor,
  store,
  { tickMs: 100, maxTicks: 500, stopWhenDrained: true },
  logger,
);

const hardTimeout = setTimeout(() => {
  console.error('demo: hard timeout exceeded');
  process.exit(2);
}, 60_000);
hardTimeout.unref();

const outcome = await loop.start();
clearTimeout(hardTimeout);

// --- verification -----------------------------------------------------------
const counts = store.counts();
const failures: string[] = [];
if (outcome !== 'drained') failures.push(`loop outcome '${outcome}' (expected 'drained')`);
if (counts.done !== 2) failures.push(`expected 2 done issues, got ${counts.done}`);
if (counts.failed !== 0 || counts.ready !== 0 || counts.leased !== 0 || counts.active !== 0) {
  failures.push(`unexpected leftover states: ${JSON.stringify(counts)}`);
}
const repair = store.all().find((issue) => issue.labels.includes('self-repair'));
if (!repair) failures.push('no self-repair issue was created');
const mergedPrs = [...adapter.pullRequests.values()].filter((pr) => pr.merged);
if (mergedPrs.length !== 2) failures.push(`expected 2 merged PRs, got ${mergedPrs.length}`);
if (adapter.issues.size !== 2) failures.push(`expected 2 adapter issues, got ${adapter.issues.size}`);
if (existsSync(path.join(workDir, '.known-bug'))) failures.push('.known-bug regression marker still present');
const failingChecks = monitor.results.filter((result) => !result.ok);
if (failingChecks.length !== 1) failures.push(`expected exactly 1 failing post-merge check, got ${failingChecks.length}`);

console.log('\n=== demo summary ===');
console.log(
  JSON.stringify(
    {
      outcome,
      ticks: loop.tickCount,
      counts,
      mergedPrs: mergedPrs.map((pr) => pr.number),
      postMergeResults: monitor.results.map((result) => ({ pr: result.merge.prNumber, ok: result.ok })),
    },
    null,
    2,
  ),
);

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}
console.log('demo OK: full self-repair loop completed');
process.exit(0);
