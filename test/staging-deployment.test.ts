import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultProjectConfig } from '../src/core/config.js';
import { PersistentTaskStore } from '../src/core/persistent-store.js';
import { StagingDeploymentController } from '../src/deployment/controller.js';
import { runProcess, type ProcessOptions } from '../src/runtime/safe-process.js';
import { makeTmp } from './helpers.js';

describe('StagingDeploymentController', () => {
  it('deploys an immutable exact commit and verifies the same revision from health', async () => {
    const root = gitRepo();
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const config = defaultProjectConfig(root, 'fixture', 'owner/fixture');
    config.deployment.staging = {
      ...config.deployment.staging,
      enabled: true,
      project: 'project-id',
      environment: 'staging',
      service: 'service-id',
      healthUrl: 'https://fixture.example/api/health',
      lifecycleGateIds: ['staging-e2e'],
    };
    config.gates = [{ id: 'staging-e2e', kind: 'e2e', command: 'fixture-lifecycle', args: [], required: true, timeoutMs: 1_000 }];
    const store = new PersistentTaskStore('deploy-fixture', makeTmp('deploy-state'));
    const calls: ProcessOptions[] = [];
    const runner = async (options: ProcessOptions) => {
      calls.push(options);
      if (options.command === 'railway' && options.args?.[0] === 'up') return receipt(options, '{"deploymentId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}\n');
      if (options.command === 'railway') return receipt(options, '[{"id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","status":"SUCCESS"}]\n');
      if (options.command === 'fixture-lifecycle') return receipt(options, 'passed\n');
      return runProcess(options);
    };
    const controller = new StagingDeploymentController(
      config,
      store,
      runner,
      async () => new Response(JSON.stringify({ ok: true, revision: sha }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const deployment = await controller.deploy({ planId: 'plan_1', wave: 1, commitSha: sha });

    expect(deployment.status).toBe('succeeded');
    expect(deployment.observedRevision).toBe(sha);
    expect(calls.find((call) => call.command === 'railway' && call.args?.[0] === 'up')?.args).toEqual(expect.arrayContaining([
      '--project', 'project-id', '--environment', 'staging', '--service', 'service-id', '--detach', '--json', '--path-as-root',
    ]));
    expect(store.getDeployment(deployment.id)?.status).toBe('succeeded');
    const lifecycle = calls.find((call) => call.command === 'fixture-lifecycle');
    expect(lifecycle?.cwd).toContain(path.join('deployments', deployment.id, 'checkout'));
    expect(lifecycle?.env?.QWEN_HARNESS_EXPECTED_SHA).toBe(sha);
    expect(lifecycle?.env?.RAILWAY_TOKEN).toBeUndefined();
    store.close();
  });

  it('fails verification when staging reports a different revision', async () => {
    const root = gitRepo();
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const config = defaultProjectConfig(root, 'fixture', 'owner/fixture');
    config.deployment.staging = {
      ...config.deployment.staging,
      enabled: true,
      project: 'project-id', environment: 'staging', service: 'service-id', healthUrl: 'https://fixture.example/api/health',
    };
    const store = new PersistentTaskStore('deploy-mismatch', makeTmp('deploy-mismatch-state'));
    const runner = async (options: ProcessOptions) => {
      if (options.command === 'railway' && options.args?.[0] === 'up') return receipt(options, '{"deploymentId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}\n');
      if (options.command === 'railway') return receipt(options, '[{"id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","status":"SUCCESS"}]\n');
      return runProcess(options);
    };
    const controller = new StagingDeploymentController(
      config, store, runner,
      async () => new Response(JSON.stringify({ revision: 'b'.repeat(40) }), { status: 200 }),
    );
    const deployment = await controller.deploy({ planId: 'plan_1', wave: 1, commitSha: sha });
    expect(deployment.status).toBe('failed');
    expect(deployment.error).toMatch(/revision mismatch/);
    store.close();
  });

  it('reconciles an interrupted Railway deployment without creating a second upload', async () => {
    const root = gitRepo();
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const config = defaultProjectConfig(root, 'fixture', 'owner/fixture');
    config.deployment.staging = {
      ...config.deployment.staging,
      enabled: true,
      project: 'project-id', environment: 'staging', service: 'service-id', healthUrl: 'https://fixture.example/api/health',
    };
    const store = new PersistentTaskStore('deploy-reconcile', makeTmp('deploy-reconcile-state'));
    const record = store.saveDeployment({
      id: 'deploy_interrupted', projectId: store.projectId, planId: 'plan_1', wave: 1, provider: 'railway', commitSha: sha,
      previousVerifiedCommitSha: null, externalId: null, status: 'uploading',
      healthUrl: config.deployment.staging.healthUrl, observedRevision: null, error: null, startedAt: 1, updatedAt: 1, completedAt: null,
    });
    const calls: ProcessOptions[] = [];
    const runner = async (options: ProcessOptions) => {
      calls.push(options);
      if (options.command === 'railway') return receipt(options, `[{"id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","status":"SUCCESS","message":"qwen-harness plan_1 wave 1 ${sha}"}]\n`);
      return runProcess(options);
    };
    const controller = new StagingDeploymentController(
      config, store, runner,
      async () => new Response(JSON.stringify({ revision: sha }), { status: 200 }),
    );

    const reconciled = await controller.reconcile(record);
    expect(reconciled.status).toBe('succeeded');
    expect(calls.some((call) => call.command === 'railway' && call.args?.[0] === 'up')).toBe(false);
    expect(calls.some((call) => call.command === 'git' && call.args?.[1] === 'add')).toBe(true);
    store.close();
  });
});

function receipt(options: ProcessOptions, stdout: string) {
  return Promise.resolve({
    command: options.command, args: options.args ?? [], cwd: options.cwd, exitCode: 0, stdout, stderr: '',
    durationMs: 1, timedOut: false, aborted: false,
  });
}

function gitRepo(): string {
  const root = makeTmp('staging-repo');
  writeFileSync(path.join(root, 'package.json'), '{}\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  return root;
}
