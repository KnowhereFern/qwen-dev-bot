import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PersistentTaskStore } from '../core/persistent-store.js';
import { PersistentTaskStore as Store } from '../core/persistent-store.js';
import { harnessStateRoot } from '../core/state-paths.js';
import type { ControllerRelease, ProjectConfig } from '../core/types.js';
import { runProcess } from '../runtime/safe-process.js';

interface LauncherManifest {
  version: 1;
  releaseId: string;
  activeRoot: string;
  baselineReleaseId: string | null;
  baselineRoot: string;
  commitSha: string;
  probationEndsAt: number;
  writtenAt: number;
  checksum: string;
}

export interface ControllerTickResult {
  release: ControllerRelease | null;
  promoted: boolean;
}

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROTECTED_CONTROLLER_PATHS = [
  'bin/qwen-harness-launcher.mjs',
  'scripts/controller-acceptance.mjs',
  'src/core/config.ts',
  'src/self-hosting/releases.ts',
  'src/rewards/',
] as const;

export class ControllerReleaseManager {
  readonly controllerRoot: string;
  readonly manifestFile: string;
  readonly historyFile: string;

  constructor(
    private readonly config: ProjectConfig,
    private readonly store: PersistentTaskStore,
    private readonly stateRoot = harnessStateRoot(),
    private readonly protectedEvaluation: { command: string; args: string[] } | null = null,
  ) {
    this.controllerRoot = path.join(stateRoot, 'controller');
    this.manifestFile = path.join(this.controllerRoot, 'active-release.json');
    this.historyFile = path.join(this.controllerRoot, 'release-history.json');
  }

  async evaluate(commitSha: string, signal?: AbortSignal): Promise<ControllerRelease> {
    this.assertEnabled();
    await this.assertDeliveryProven();
    if (!/^[0-9a-f]{40}$/i.test(commitSha)) throw new Error('Controller candidate requires a full commit SHA');
    if (!this.protectedEvaluation) await this.assertGovernanceUnchanged(commitSha, signal);
    const id = `controller_${createHash('sha256').update(commitSha).digest('hex').slice(0, 20)}`;
    const existing = this.store.listControllerReleases().find((release) => release.id === id);
    if (existing?.status === 'ready' || existing?.status === 'active' || existing?.status === 'probation') return existing;
    if (existing?.status === 'rejected' || existing?.status === 'rolled_back') {
      throw new Error(`Controller candidate ${commitSha} is ineligible after ${existing.status}; evaluate a new commit`);
    }
    const releaseRoot = path.join(this.controllerRoot, 'releases', id);
    const now = Date.now();
    let release: ControllerRelease = existing ?? {
      id,
      version: 'unknown',
      commitSha,
      root: releaseRoot,
      status: 'candidate',
      baselineReleaseId: this.activeManifest()?.releaseId ?? null,
      evaluationHash: null,
      promotedAt: null,
      probationEndsAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.saveControllerRelease(release);
    try {
      await this.prepareRelease(releaseRoot, commitSha, signal);
      const manifest = JSON.parse(readFileSync(path.join(releaseRoot, 'package.json'), 'utf8')) as { version?: string };
      release = this.save({ ...release, version: manifest.version ?? 'unknown', status: 'evaluating', updatedAt: Date.now() });
      const receipts: Array<{ command: string; args: string[]; exitCode: number | null; outputHash: string }> = [];
      for (const command of [...this.config.selfHosting.evaluationCommands, ...this.config.selfHosting.canaryCommands]) {
        const result = await runProcess({
          command: command.command,
          args: command.args,
          cwd: releaseRoot,
          timeoutMs: 30 * 60_000,
          signal,
          env: sanitizedEnvironment(),
          maxOutputBytes: 10 * 1024 * 1024,
        });
        receipts.push({
          command: command.command,
          args: command.args,
          exitCode: result.exitCode,
          outputHash: sha256(`${result.stdout}\n${result.stderr}`),
        });
        if (result.exitCode !== 0) throw new Error(`Controller evaluation failed: ${command.command} ${command.args.join(' ')}`);
      }
      const protectedCommand = this.protectedEvaluation ?? {
        command: process.execPath,
        args: ['--import', 'tsx', path.join(PACKAGE_ROOT, 'scripts', 'controller-acceptance.mjs'), releaseRoot, PACKAGE_ROOT],
      };
      const protectedResult = await runProcess({
        command: protectedCommand.command,
        args: protectedCommand.args,
        cwd: releaseRoot,
        timeoutMs: 5 * 60_000,
        signal,
        env: sanitizedEnvironment(),
        maxOutputBytes: 5 * 1024 * 1024,
      });
      receipts.push({
        command: protectedCommand.command,
        args: protectedCommand.args,
        exitCode: protectedResult.exitCode,
        outputHash: sha256(`${protectedResult.stdout}\n${protectedResult.stderr}`),
      });
      if (protectedResult.exitCode !== 0) {
        throw new Error(`Protected controller acceptance failed: ${protectedResult.stderr || protectedResult.stdout}`);
      }
      const evaluationHash = sha256(JSON.stringify(receipts));
      release = this.save({ ...release, status: 'ready', evaluationHash, updatedAt: Date.now() });
      return release;
    } catch (error) {
      this.save({ ...release, status: 'rejected', updatedAt: Date.now() });
      throw error;
    }
  }

  async tickAuto(signal?: AbortSignal): Promise<ControllerTickResult> {
    if (!this.config.selfHosting.enabled) return { release: null, promoted: false };
    const observed = await this.observe(signal);
    if (observed?.status === 'probation') {
      const activeRoot = this.activeManifest()?.activeRoot;
      return { release: observed, promoted: Boolean(activeRoot && path.resolve(activeRoot) !== PACKAGE_ROOT) };
    }
    const fetched = await runProcess({
      command: 'git',
      args: ['fetch', '--quiet', 'origin', this.config.project.defaultBranch],
      cwd: this.config.selfHosting.candidateRoot,
      timeoutMs: 2 * 60_000,
      signal,
    });
    if (fetched.exitCode !== 0) throw new Error(`Could not fetch controller candidates: ${fetched.stderr}`);
    const head = await runProcess({
      command: 'git',
      args: ['rev-parse', `refs/remotes/origin/${this.config.project.defaultBranch}`],
      cwd: this.config.selfHosting.candidateRoot,
      timeoutMs: 10_000,
      signal,
    });
    if (head.exitCode !== 0) throw new Error('Could not resolve controller candidate head');
    const commitSha = head.stdout.trim();
    if (observed?.commitSha === commitSha) return { release: observed, promoted: false };
    const priorCandidate = this.store.listControllerReleases().find((release) => release.commitSha === commitSha);
    if (priorCandidate && ['rejected', 'rolled_back'].includes(priorCandidate.status)) {
      return { release: priorCandidate, promoted: false };
    }
    if (!this.activeManifest()) {
      const local = await runProcess({ command: 'git', args: ['rev-parse', 'HEAD'], cwd: PACKAGE_ROOT, timeoutMs: 10_000, signal });
      if (local.exitCode === 0 && local.stdout.trim() === commitSha) return { release: null, promoted: false };
    }
    const candidate = await this.evaluate(commitSha, signal);
    if (this.config.selfHosting.autoPromote && candidate.status === 'ready') {
      return { release: await this.promote(candidate.id), promoted: true };
    }
    return { release: candidate, promoted: false };
  }

  async promote(releaseId: string): Promise<ControllerRelease> {
    this.assertEnabled();
    await this.assertDeliveryProven();
    await this.assertIdleBoundary();
    const release = this.store.listControllerReleases().find((candidate) => candidate.id === releaseId);
    if (!release || release.status !== 'ready' || !release.evaluationHash) throw new Error(`Controller release ${releaseId} is not ready`);
    const previous = this.activeManifest();
    const now = Date.now();
    const manifest = signManifest({
      version: 1,
      releaseId: release.id,
      activeRoot: release.root,
      baselineReleaseId: previous?.releaseId ?? null,
      baselineRoot: previous?.activeRoot ?? PACKAGE_ROOT,
      commitSha: release.commitSha,
      probationEndsAt: now + this.config.selfHosting.probationMs,
      writtenAt: now,
    });
    writeAtomicJson(this.manifestFile, manifest);
    if (previous?.releaseId) {
      const previousRelease = this.store.listControllerReleases().find((candidate) => candidate.id === previous.releaseId);
      if (previousRelease && ['active', 'probation'].includes(previousRelease.status)) {
        this.save({ ...previousRelease, status: 'inactive', updatedAt: now });
      }
    }
    const promoted = this.save({
      ...release,
      status: 'probation',
      baselineReleaseId: manifest.baselineReleaseId,
      promotedAt: now,
      probationEndsAt: manifest.probationEndsAt,
      updatedAt: now,
    });
    this.store.recordEvent('controller.promoted', null, {
      releaseId: promoted.id,
      commitSha: promoted.commitSha,
      baselineReleaseId: promoted.baselineReleaseId,
      probationEndsAt: promoted.probationEndsAt,
    }, `controller:promoted:${promoted.id}`);
    return promoted;
  }

  async observe(signal?: AbortSignal): Promise<ControllerRelease | null> {
    const manifest = this.activeManifest();
    if (!manifest) return null;
    let release = this.store.listControllerReleases().find((candidate) => candidate.id === manifest.releaseId);
    if (!release && manifest.releaseId === 'installed-baseline') return null;
    if (!release) throw new Error(`Active controller release ${manifest.releaseId} is missing from the ledger`);
    if (release.status === 'ready') {
      release = this.save({
        ...release,
        status: 'probation',
        promotedAt: manifest.writtenAt,
        probationEndsAt: manifest.probationEndsAt,
        updatedAt: Date.now(),
      });
    }
    const health = await runProcess({
      command: process.execPath,
      args: [path.join(manifest.activeRoot, 'bin', 'qwen-harness.mjs'), '--version'],
      cwd: manifest.activeRoot,
      timeoutMs: 30_000,
      signal,
      env: sanitizedEnvironment(),
    });
    if (health.exitCode !== 0 || health.stdout.trim() !== release.version) return this.rollback(release.id);
    if (release.status === 'probation' && Date.now() >= manifest.probationEndsAt) {
      return this.save({ ...release, status: 'active', updatedAt: Date.now() });
    }
    return release;
  }

  rollback(releaseId: string): ControllerRelease {
    const manifest = this.activeManifest();
    const release = this.store.listControllerReleases().find((candidate) => candidate.id === releaseId);
    if (!manifest || !release || manifest.releaseId !== releaseId) throw new Error(`Controller release ${releaseId} is not active`);
    const baseline = release.baselineReleaseId
      ? this.store.listControllerReleases().find((candidate) => candidate.id === release.baselineReleaseId) ?? null
      : null;
    const now = Date.now();
    const restored = signManifest({
      version: 1,
      releaseId: baseline?.id ?? 'installed-baseline',
      activeRoot: baseline?.root ?? manifest.baselineRoot,
      baselineReleaseId: null,
      baselineRoot: manifest.baselineRoot,
      commitSha: baseline?.commitSha ?? 'installed',
      probationEndsAt: 0,
      writtenAt: now,
    });
    writeAtomicJson(this.manifestFile, restored);
    if (baseline) this.save({ ...baseline, status: 'active', updatedAt: now });
    const rolledBack = this.save({ ...release, status: 'rolled_back', updatedAt: now });
    this.store.recordEvent('controller.rolled_back', null, {
      releaseId: rolledBack.id,
      restoredReleaseId: baseline?.id ?? 'installed-baseline',
    }, `controller:rolled_back:${rolledBack.id}`);
    return rolledBack;
  }

  activeManifest(): LauncherManifest | null {
    if (!existsSync(this.manifestFile)) return null;
    const value = JSON.parse(readFileSync(this.manifestFile, 'utf8')) as LauncherManifest;
    const { checksum, ...unsigned } = value;
    if (checksum !== sha256(JSON.stringify(unsigned))) throw new Error('Controller launcher manifest checksum is invalid');
    if (!path.isAbsolute(value.activeRoot) || !existsSync(path.join(value.activeRoot, 'bin', 'qwen-harness.mjs'))) {
      throw new Error('Controller launcher manifest points to an invalid release root');
    }
    return value;
  }

  private async prepareRelease(releaseRoot: string, commitSha: string, signal?: AbortSignal): Promise<void> {
    mkdirSync(path.dirname(releaseRoot), { recursive: true, mode: 0o700 });
    if (!existsSync(releaseRoot)) {
      const created = await runProcess({ command: 'git', args: ['worktree', 'add', '--detach', releaseRoot, commitSha], cwd: this.config.selfHosting.candidateRoot, timeoutMs: 60_000, signal });
      if (created.exitCode !== 0) throw new Error(`Could not prepare controller candidate: ${created.stderr}`);
    }
    const actual = await runProcess({ command: 'git', args: ['rev-parse', 'HEAD'], cwd: releaseRoot, timeoutMs: 10_000, signal });
    if (actual.exitCode !== 0 || actual.stdout.trim() !== commitSha) throw new Error(`Controller candidate root is not ${commitSha}`);
  }

  private async assertGovernanceUnchanged(commitSha: string, signal?: AbortSignal): Promise<void> {
    let baseline = await runProcess({ command: 'git', args: ['rev-parse', 'HEAD'], cwd: PACKAGE_ROOT, timeoutMs: 10_000, signal });
    if (baseline.exitCode !== 0 || !/^[0-9a-f]{40}$/i.test(baseline.stdout.trim())) {
      baseline = await runProcess({ command: 'git', args: ['rev-parse', 'HEAD'], cwd: this.config.selfHosting.candidateRoot, timeoutMs: 10_000, signal });
    }
    if (baseline.exitCode !== 0 || !/^[0-9a-f]{40}$/i.test(baseline.stdout.trim()) || baseline.stdout.trim() === commitSha) return;
    const changed = await runProcess({
      command: 'git',
      args: ['diff', '--name-only', `${baseline.stdout.trim()}..${commitSha}`],
      cwd: this.config.selfHosting.candidateRoot,
      timeoutMs: 30_000,
      signal,
    });
    if (changed.exitCode !== 0) throw new Error(`Could not compare protected controller governance: ${changed.stderr}`);
    const violations = changed.stdout.split('\n').map((value) => value.trim()).filter(Boolean).filter((file) =>
      PROTECTED_CONTROLLER_PATHS.some((protectedPath) => protectedPath.endsWith('/') ? file.startsWith(protectedPath) : file === protectedPath),
    );
    if (violations.length > 0) throw new Error(`Controller candidate changes protected governance or evaluation paths: ${violations.join(', ')}`);
  }

  private async assertDeliveryProven(): Promise<void> {
    const stateDir = path.join(this.stateRoot, 'projects', this.config.selfHosting.requiredProjectId);
    if (!existsSync(stateDir)) throw new Error(`Required delivery project ${this.config.selfHosting.requiredProjectId} has no state`);
    const target = new Store(this.config.selfHosting.requiredProjectId, stateDir);
    try {
      const delivered = target.listPortfolioPlans().find((plan) =>
        ['delivered', 'maintaining'].includes(plan.status) &&
        plan.deliveredAt &&
        Date.now() - plan.deliveredAt >= this.config.selfHosting.deliveryObservationMs,
      );
      if (!delivered) throw new Error(`Required delivery project has not completed its ${this.config.selfHosting.deliveryObservationMs}ms observation period`);
    } finally {
      target.close();
    }
  }

  private async assertIdleBoundary(): Promise<void> {
    const busy = this.store.list().find((task) => !['done', 'failed', 'quarantined', 'cancelled'].includes(task.state));
    if (busy) throw new Error(`Controller promotion requires an idle boundary; task ${busy.id} is ${busy.state}`);
  }

  private assertEnabled(): void {
    if (!this.config.selfHosting.enabled) throw new Error('Self-hosting is not enabled');
  }

  private save(release: ControllerRelease): ControllerRelease {
    const saved = this.store.saveControllerRelease(release);
    const history = existsSync(this.historyFile)
      ? JSON.parse(readFileSync(this.historyFile, 'utf8')) as ControllerRelease[]
      : [];
    const updated = [...history.filter((candidate) => candidate.id !== saved.id), saved]
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    writeAtomicJson(this.historyFile, updated);
    return saved;
  }
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    CI: '1',
    NO_COLOR: '1',
  };
}

function signManifest(value: Omit<LauncherManifest, 'checksum'>): LauncherManifest {
  return { ...value, checksum: sha256(JSON.stringify(value)) };
}

function writeAtomicJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  chmodSync(file, 0o600);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
