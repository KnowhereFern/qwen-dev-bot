#!/usr/bin/env node
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const candidateRoot = path.resolve(process.argv[2] ?? '');
if (!process.argv[2] || candidateRoot === path.parse(candidateRoot).root) fail('candidate root is required');
const baselineRoot = path.resolve(process.argv[3] ?? candidateRoot);

const temporary = mkdtempSync(path.join(os.tmpdir(), 'qwen-controller-acceptance-'));
try {
  const configModule = await load(candidateRoot, 'src/core/config.ts');
  const storeModule = await load(candidateRoot, 'src/core/persistent-store.ts');
  const baselineStoreModule = await load(baselineRoot, 'src/core/persistent-store.ts');
  const plannerModule = await load(candidateRoot, 'src/portfolio/planner.ts');
  const fixtureRoot = path.join(temporary, 'project');
  mkdirSync(path.join(fixtureRoot, '.qwen-harness'), { recursive: true });

  const defaults = configModule.defaultProjectConfig(fixtureRoot, 'acceptance', 'owner/acceptance');
  const requiredProtectedPaths = [
    'bin/qwen-harness-launcher.mjs',
    'scripts/controller-acceptance.mjs',
    'src/core/config.ts',
    'src/self-hosting/releases.ts',
    'src/rewards/',
  ];
  for (const protectedPath of requiredProtectedPaths) {
    assert(existsInCandidate(protectedPath), `missing protected governance path ${protectedPath}`);
  }

  const legacy = structuredClone(defaults);
  legacy.configVersion = 1;
  delete legacy.program;
  delete legacy.evolution;
  delete legacy.deployment;
  delete legacy.selfHosting;
  const configFile = path.join(fixtureRoot, '.qwen-harness', 'project.yml');
  writeFileSync(configFile, `${JSON.stringify(legacy)}\n`);
  const migrated = configModule.loadProjectConfig(configFile);
  assert(migrated.program.enabled === false, 'version 1 program authority expanded');
  assert(migrated.deployment.staging.enabled === false, 'version 1 deployment authority expanded');
  assert(migrated.selfHosting.enabled === false, 'version 1 self-hosting authority expanded');

  const storeDir = path.join(temporary, 'state');
  let store = new storeModule.PersistentTaskStore('acceptance-project', storeDir);
  const task = store.upsert({ issueNumber: 1, title: 'failure lineage', state: 'ready', maxAttempts: 5 });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    store.claimNext('acceptance-worker', 1_000, attempt * 1_000);
    store.transition(task.id, 'active');
    store.recordFailure(task.id, `same compiler failure at /tmp/run-${attempt}/main.ts line ${attempt}`, 3);
  }
  assert(store.get(task.id).state === 'quarantined', 'third identical failure did not quarantine');
  store.saveDeployment({
    id: 'deployment-proof', projectId: store.projectId, planId: 'plan-proof', wave: 1, provider: 'railway',
    commitSha: 'a'.repeat(40), previousVerifiedCommitSha: null, externalId: 'external-proof', status: 'deploying',
    healthUrl: 'https://example.invalid/health', observedRevision: null, error: null,
    startedAt: 1, updatedAt: 1, completedAt: null,
  });
  store.close();
  store = new storeModule.PersistentTaskStore('acceptance-project', storeDir);
  assert(store.get(task.id).state === 'quarantined', 'task recovery lost quarantine state');
  assert(store.getDeployment('deployment-proof')?.externalId === 'external-proof', 'deployment recovery lost provider identity');
  store.close();
  const rollbackStore = new baselineStoreModule.PersistentTaskStore('acceptance-project', storeDir);
  assert(rollbackStore.get(task.id).state === 'quarantined', 'rollback controller cannot read candidate task state');
  assert(rollbackStore.getDeployment('deployment-proof')?.externalId === 'external-proof', 'rollback controller cannot read candidate deployment state');
  rollbackStore.close();

  const draft = plannerModule.validatePortfolioDraft({
    title: 'Acceptance replay', objective: 'Deliver one verified capability', constraints: [], definitionOfDone: ['Verified'],
    technologyDecisions: [], deploymentDecisions: [], stories: [{
      key: 'S1', title: 'Capability', goal: 'Implement it', acceptanceCriteria: ['Test passes'], constraints: [],
      requiredGateIds: [], rewardCriterionIds: [], risk: 'low', dependsOn: [], rollback: 'Revert',
      technologyDecisionIds: [], deploymentDecisionIds: [], coverageIds: ['REQ1'],
    }],
  }, [], [], 5, defaults.technologyPolicy, ['REQ1']);
  assert(draft.stories[0]?.coverageIds?.[0] === 'REQ1', 'sanitized planning replay lost objective coverage');

  process.stdout.write('PASS protected controller acceptance\n');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

async function load(root, relative) {
  return import(pathToFileURL(path.join(root, relative)).href);
}

function existsInCandidate(relative) {
  return existsSync(path.join(candidateRoot, relative));
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function fail(message) {
  throw new Error(`Protected controller acceptance: ${message}`);
}
