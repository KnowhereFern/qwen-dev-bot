import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { DeploymentRecord, GateDefinition, ProjectConfig } from '../core/types.js';
import type { PersistentTaskStore } from '../core/persistent-store.js';
import { redactText } from '../core/ledger.js';
import { gateEnvironment, resolveInside, runProcess, type ProcessOptions } from '../runtime/safe-process.js';
import { prepareProjectCheckout } from '../runtime/checkout-preflight.js';

type ProcessRunner = (options: ProcessOptions) => ReturnType<typeof runProcess>;

const TERMINAL_RAILWAY_STATUSES = new Set(['SUCCESS', 'FAILED', 'CRASHED', 'REMOVED', 'SKIPPED', 'NEEDS_APPROVAL']);

export class StagingDeploymentController {
  constructor(
    private readonly config: ProjectConfig,
    private readonly store: PersistentTaskStore,
    private readonly processRunner: ProcessRunner = runProcess,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async deploy(input: { planId: string; wave: number; commitSha: string; signal?: AbortSignal }): Promise<DeploymentRecord> {
    const staging = this.config.deployment.staging;
    if (!staging.enabled) throw new Error('Staging deployment is not enabled');
    await this.assertCommit(input.commitSha, input.signal);
    const previous = this.store.listDeployments(input.planId).find((record) => record.status === 'succeeded') ?? null;
    const now = Date.now();
    let record: DeploymentRecord = {
      id: `deploy_${createHash('sha256').update(`${this.store.projectId}:${input.planId}:${input.wave}:${input.commitSha}`).digest('hex').slice(0, 20)}`,
      projectId: this.store.projectId,
      planId: input.planId,
      wave: input.wave,
      provider: staging.provider,
      commitSha: input.commitSha,
      previousVerifiedCommitSha: previous?.commitSha ?? null,
      externalId: null,
      status: 'pending',
      healthUrl: staging.healthUrl,
      observedRevision: null,
      error: null,
      startedAt: now,
      updatedAt: now,
      completedAt: null,
    };
    const existing = this.store.getDeployment(record.id);
    if (existing?.status === 'succeeded') return existing;
    if (existing) record = existing;
    this.store.saveDeployment(record);
    const checkout = path.join(this.store.stateDir, 'deployments', record.id, 'checkout');
    try {
      await this.prepareCheckout(checkout, input.commitSha, input.signal);
      record = this.save({ ...record, status: 'uploading', updatedAt: Date.now(), error: null });
      const externalId = staging.provider === 'railway'
        ? await this.startRailway(checkout, record, input.signal)
        : await this.runCustomDeployment(checkout, record, input.signal);
      record = this.save({ ...record, externalId, status: 'deploying', updatedAt: Date.now() });
      if (staging.provider === 'railway') await this.waitForRailway(externalId, input.signal);
      record = this.save({ ...record, status: 'verifying', updatedAt: Date.now() });
      const observedRevision = await this.verifyHealth(input.commitSha, input.signal);
      await this.runLifecycleGates(checkout, input.commitSha, input.signal);
      record = this.save({
        ...record,
        status: 'succeeded',
        observedRevision,
        completedAt: Date.now(),
        updatedAt: Date.now(),
      });
      return record;
    } catch (error) {
      const message = redactText(error instanceof Error ? error.message : String(error)).slice(0, 4_000);
      record = this.save({ ...record, status: 'failed', error: message, completedAt: Date.now(), updatedAt: Date.now() });
      if (record.previousVerifiedCommitSha && staging.rollback?.dataCompatible) {
        record = await this.rollback(record, input.signal);
      }
      return record;
    } finally {
      await this.removeCheckout(checkout);
    }
  }

  async reconcile(record: DeploymentRecord, signal?: AbortSignal): Promise<DeploymentRecord> {
    if (['succeeded', 'failed', 'rolled_back'].includes(record.status)) return record;
    if (record.status === 'pending') return this.deploy({ planId: record.planId, wave: record.wave, commitSha: record.commitSha, signal });
    if (!record.externalId && record.provider === 'railway') {
      const recoveredId = await this.recoverRailwayDeploymentId(record, signal);
      if (recoveredId) record = this.save({ ...record, externalId: recoveredId, status: 'deploying', updatedAt: Date.now() });
    }
    if (!record.externalId || record.provider !== 'railway') return this.save({
      ...record,
      status: 'failed',
      error: 'Interrupted deployment cannot be reconciled without a unique provider deployment id; no new deployment was started',
      completedAt: Date.now(),
      updatedAt: Date.now(),
    });
    const checkout = path.join(this.store.stateDir, 'deployments', record.id, 'checkout');
    try {
      await this.assertCommit(record.commitSha, signal);
      await this.prepareCheckout(checkout, record.commitSha, signal);
      await this.waitForRailway(record.externalId, signal);
      const observedRevision = await this.verifyHealth(record.commitSha, signal);
      await this.runLifecycleGates(checkout, record.commitSha, signal);
      return this.save({ ...record, status: 'succeeded', observedRevision, error: null, completedAt: Date.now(), updatedAt: Date.now() });
    } catch (error) {
      let failed = this.save({
        ...record,
        status: 'failed',
        error: redactText(error instanceof Error ? error.message : String(error)).slice(0, 4_000),
        completedAt: Date.now(),
        updatedAt: Date.now(),
      });
      if (failed.previousVerifiedCommitSha && this.config.deployment.staging.rollback?.dataCompatible) {
        failed = await this.rollback(failed, signal);
      }
      return failed;
    } finally {
      await this.removeCheckout(checkout);
    }
  }

  private async assertCommit(commitSha: string, signal?: AbortSignal): Promise<void> {
    if (!/^[0-9a-f]{40}$/i.test(commitSha)) throw new Error(`Deployment requires a full commit SHA, received ${commitSha}`);
    const resolved = await this.processRunner({ command: 'git', args: ['rev-parse', `${commitSha}^{commit}`], cwd: this.config.project.root, timeoutMs: 10_000, signal });
    if (resolved.exitCode !== 0 || resolved.stdout.trim() !== commitSha) throw new Error(`Deployment commit ${commitSha} is unavailable locally`);
  }

  private async prepareCheckout(checkout: string, commitSha: string, signal?: AbortSignal): Promise<void> {
    mkdirSync(path.dirname(checkout), { recursive: true, mode: 0o700 });
    if (existsSync(checkout)) await this.removeCheckout(checkout);
    const result = await this.processRunner({
      command: 'git', args: ['worktree', 'add', '--detach', checkout, commitSha], cwd: this.config.project.root, timeoutMs: 60_000, signal,
    });
    if (result.exitCode !== 0) throw new Error(`Could not create immutable deployment checkout: ${result.stderr}`);
  }

  private async removeCheckout(checkout: string): Promise<void> {
    if (existsSync(checkout)) {
      await this.processRunner({ command: 'git', args: ['worktree', 'remove', '--force', checkout], cwd: this.config.project.root, timeoutMs: 30_000 });
    }
    await this.processRunner({ command: 'git', args: ['worktree', 'prune'], cwd: this.config.project.root, timeoutMs: 30_000 });
    if (existsSync(path.dirname(checkout))) rmSync(path.dirname(checkout), { recursive: true, force: true });
  }

  private async startRailway(checkout: string, record: DeploymentRecord, signal?: AbortSignal): Promise<string> {
    const staging = this.config.deployment.staging;
    if (staging.revisionEnvKey) {
      const revision = await this.processRunner({
        command: 'railway',
        args: [
          'variable', 'set', `${staging.revisionEnvKey}=${record.commitSha}`, '--skip-deploys', '--json',
          '--project', staging.project,
          '--environment', staging.environment,
          '--service', staging.service,
        ],
        cwd: checkout,
        timeoutMs: 30_000,
        signal,
        env: { ...process.env, RAILWAY_CALLER: 'qwen-harness:staging-controller' },
      });
      if (revision.exitCode !== 0) throw new Error(`Railway revision variable failed: ${revision.stderr || revision.stdout}`);
    }
    const result = await this.processRunner({
      command: 'railway',
      args: [
        'up', checkout,
        '--project', staging.project,
        '--environment', staging.environment,
        '--service', staging.service,
        '--detach', '--json', '--path-as-root',
        '--message', `qwen-harness ${record.planId} wave ${record.wave} ${record.commitSha}`,
      ],
      cwd: checkout,
      timeoutMs: 5 * 60_000,
      signal,
      env: { ...process.env, RAILWAY_CALLER: 'qwen-harness:staging-controller' },
      maxOutputBytes: 5 * 1024 * 1024,
    });
    if (result.exitCode !== 0) throw new Error(`Railway upload failed: ${result.stderr || result.stdout}`);
    const values = result.stdout.split('\n').map(parseJson).filter(isRecord);
    const externalId = values.flatMap(findDeploymentIds).at(-1);
    if (!externalId) throw new Error('Railway upload did not return a deployment id');
    return externalId;
  }

  private async waitForRailway(externalId: string, signal?: AbortSignal): Promise<void> {
    const staging = this.config.deployment.staging;
    const deadline = Date.now() + staging.timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.processRunner({
        command: 'railway',
        args: ['deployment', 'list', '--project', staging.project, '--environment', staging.environment, '--service', staging.service, '--limit', '100', '--json'],
        cwd: this.config.project.root,
        timeoutMs: 30_000,
        signal,
        env: { ...process.env, RAILWAY_CALLER: 'qwen-harness:staging-controller' },
      });
      if (result.exitCode !== 0) throw new Error(`Railway deployment status failed: ${result.stderr}`);
      const rows = JSON.parse(result.stdout) as Array<{ id?: string; status?: string }>;
      const deployment = rows.find((row) => row.id === externalId);
      if (!deployment) throw new Error(`Railway deployment ${externalId} was not found in the configured target`);
      const status = String(deployment.status ?? '').toUpperCase();
      if (status === 'SUCCESS') return;
      if (TERMINAL_RAILWAY_STATUSES.has(status)) throw new Error(`Railway deployment ${externalId} ended in ${status}`);
      await delay(2_000, signal);
    }
    throw new Error(`Railway deployment ${externalId} did not finish within ${staging.timeoutMs}ms`);
  }

  private async recoverRailwayDeploymentId(record: DeploymentRecord, signal?: AbortSignal): Promise<string | null> {
    const staging = this.config.deployment.staging;
    const result = await this.processRunner({
      command: 'railway',
      args: ['deployment', 'list', '--project', staging.project, '--environment', staging.environment, '--service', staging.service, '--limit', '100', '--json'],
      cwd: this.config.project.root,
      timeoutMs: 30_000,
      signal,
      env: { ...process.env, RAILWAY_CALLER: 'qwen-harness:staging-controller' },
    });
    if (result.exitCode !== 0) return null;
    const rows = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(rows)) return null;
    const marker = `qwen-harness ${record.planId} wave ${record.wave} ${record.commitSha}`;
    const matches = rows.filter((row) => JSON.stringify(row).includes(marker)).flatMap((row) => isRecord(row) ? findDeploymentIds(row) : []);
    return matches.length === 1 ? matches[0] as string : null;
  }

  private async runCustomDeployment(checkout: string, record: DeploymentRecord, signal?: AbortSignal): Promise<string> {
    const command = this.config.deployment.staging.command;
    if (!command) throw new Error('Custom staging command is not configured');
    const args = command.args.map((arg) => interpolate(arg, checkout, record.commitSha, record.id));
    const result = await this.processRunner({ command: command.command, args, cwd: checkout, timeoutMs: this.config.deployment.staging.timeoutMs, signal });
    if (result.exitCode !== 0) throw new Error(`Custom staging deployment failed: ${result.stderr || result.stdout}`);
    return record.id;
  }

  private async verifyHealth(expectedRevision: string, signal?: AbortSignal): Promise<string> {
    const staging = this.config.deployment.staging;
    const response = await this.fetchImpl(staging.healthUrl, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Staging health check returned HTTP ${response.status}`);
    const body = await response.json() as unknown;
    const observed = jsonPath(body, staging.revisionJsonPath);
    if (observed !== expectedRevision) throw new Error(`Staging revision mismatch: expected ${expectedRevision}, observed ${observed ?? '(missing)'}`);
    return observed;
  }

  private async runLifecycleGates(checkout: string, commitSha: string, signal?: AbortSignal): Promise<void> {
    const ids = this.config.deployment.staging.lifecycleGateIds;
    if (ids.length > 0) await prepareProjectCheckout(checkout, signal);
    for (const id of ids) {
      const gate = this.config.gates.find((candidate) => candidate.id === id) as GateDefinition;
      const result = await this.processRunner({
        command: gate.command,
        args: gate.args,
        cwd: gate.cwd ? resolveInside(checkout, gate.cwd) : checkout,
        timeoutMs: gate.timeoutMs,
        signal,
        env: {
          ...gateEnvironment({ ...process.env, CI: 'true', NODE_ENV: 'test' }),
          QWEN_HARNESS_STAGING_URL: this.config.deployment.staging.healthUrl.replace(/\/api\/health\/?$/, ''),
          QWEN_HARNESS_EXPECTED_SHA: commitSha,
        },
      });
      if (result.exitCode !== 0) throw new Error(`Staging lifecycle gate ${id} failed: ${result.stderr || result.stdout}`);
    }
  }

  private async rollback(record: DeploymentRecord, signal?: AbortSignal): Promise<DeploymentRecord> {
    const rollback = this.config.deployment.staging.rollback;
    if (!rollback || !record.previousVerifiedCommitSha) return record;
    const args = rollback.args.map((arg) => interpolate(arg, this.config.project.root, record.previousVerifiedCommitSha as string, record.id));
    const result = await this.processRunner({ command: rollback.command, args, cwd: this.config.project.root, timeoutMs: this.config.deployment.staging.timeoutMs, signal });
    return this.save({
      ...record,
      status: result.exitCode === 0 ? 'rolled_back' : 'failed',
      error: result.exitCode === 0 ? record.error : `${record.error ?? ''}\nRollback failed: ${redactText(result.stderr || result.stdout)}`.trim(),
      updatedAt: Date.now(),
    });
  }

  private save(record: DeploymentRecord): DeploymentRecord {
    return this.store.saveDeployment(record);
  }
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

function findDeploymentIds(value: Record<string, unknown>): string[] {
  const keys = ['deploymentId', 'deployment_id', 'id'];
  const direct = keys.flatMap((key) => typeof value[key] === 'string' && /^[0-9a-f-]{20,}$/i.test(value[key] as string) ? [value[key] as string] : []);
  return [...direct, ...Object.values(value).flatMap((child) => isRecord(child) ? findDeploymentIds(child) : [])];
}

function jsonPath(value: unknown, expression: string): string | null {
  let cursor = value;
  for (const key of expression.split('.').filter(Boolean)) {
    if (!isRecord(cursor) || !(key in cursor)) return null;
    cursor = cursor[key];
  }
  return typeof cursor === 'string' ? cursor : cursor === null || cursor === undefined ? null : String(cursor);
}

function interpolate(value: string, checkout: string, sha: string, deploymentId: string): string {
  return value.replaceAll('{checkout}', checkout).replaceAll('{sha}', sha).replaceAll('{deploymentId}', deploymentId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Deployment aborted')); }, { once: true });
  });
}
