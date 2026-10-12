import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig, TaskRecord } from '../core/types.js';
import { formatProcessFailure, runProcess, type ProcessOptions } from '../runtime/safe-process.js';

export interface WorktreeReceipt {
  path: string;
  branch: string;
  baseSha: string;
  reused: boolean;
}

/** Durable evidence for one tracked candidate edit: porcelain status, filesystem mode, and content hash. */
export interface TrackedCandidateDigest {
  status: string;
  mode: number;
  sha256: string;
}

/** The only tracked worktree status a base advance may carry: an ordinary
 * unstaged modification (' M') of an already-tracked file. Staged ('M ') and
 * mixed ('MM') modifications fail closed alongside every other status. */
const ORDINARY_TRACKED_MODIFICATIONS = new Set([' M']);

export function isOrdinaryTrackedModification(status: string): boolean {
  return ORDINARY_TRACKED_MODIFICATIONS.has(status);
}

export class GitWorkspace {
  private readonly repoRoot: string;
  private readonly worktreesRoot: string;
  protected readonly stateRoot: string;

  constructor(
    root: string,
    stateDir: string,
    private readonly config: ProjectConfig,
  ) {
    this.repoRoot = realpathSync(root);
    this.stateRoot = stateDir;
    this.worktreesRoot = path.join(stateDir, 'worktrees');
    mkdirSync(this.worktreesRoot, { recursive: true, mode: 0o700 });
  }

  async assertReady(): Promise<void> {
    await this.git(['rev-parse', '--is-inside-work-tree'], this.repoRoot);
    const status = await this.git(['status', '--porcelain=v1'], this.repoRoot);
    if (status.stdout.trim()) {
      throw new Error('Target repository has uncommitted changes; the harness will not touch a dirty checkout.');
    }
    const origin = (await this.git(['remote', 'get-url', 'origin'], this.repoRoot)).stdout.trim();
    const githubSlug = githubSlugFromRemote(origin);
    if (githubSlug && githubSlug.toLowerCase() !== this.config.project.githubRepo.toLowerCase()) {
      throw new Error(
        `Git origin points to ${githubSlug}, but project.githubRepo is ${this.config.project.githubRepo}`,
      );
    }
    if (!githubSlug && (/^[a-z][a-z0-9+.-]*:\/\//i.test(origin) || /^[^@\s]+@[^:\s]+:/.test(origin))) {
      throw new Error(`Git origin is not a supported github.com remote: ${origin}`);
    }
  }

  async baseSha(): Promise<string> {
    await this.git(
      ['fetch', '--prune', 'origin', this.config.project.defaultBranch],
      this.repoRoot,
    );
    const remote = await this.git(
      ['rev-parse', `refs/remotes/origin/${this.config.project.defaultBranch}`],
      this.repoRoot,
      false,
    );
    if (remote.exitCode === 0) return remote.stdout.trim();
    return (await this.git(['rev-parse', this.config.project.defaultBranch], this.repoRoot)).stdout.trim();
  }

  async createOrResume(task: TaskRecord): Promise<WorktreeReceipt> {
    const branch = task.branch ?? branchFor(task);
    const target = path.join(this.worktreesRoot, `${task.issueNumber}-${safeSlug(task.title)}`);
    this.assertOwnedPath(target);
    if (existsSync(target)) {
      const current = await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], target, false);
      if (current.exitCode !== 0 || current.stdout.trim() !== branch) {
        throw new Error(`Existing harness worktree ${target} is not on expected branch ${branch}`);
      }
      return { path: target, branch, baseSha: task.baseSha ?? (await this.baseSha()), reused: true };
    }

    const baseSha = task.baseSha ?? (await this.baseSha());
    const localBranch = await this.git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], this.repoRoot, false);
    if (localBranch.exitCode === 0) {
      const localSha = (await this.git(['rev-parse', `refs/heads/${branch}`], this.repoRoot)).stdout.trim();
      if (task.commitSha && localSha !== task.commitSha) {
        throw new Error(`Existing branch ${branch} is ${localSha}; expected persisted candidate ${task.commitSha}`);
      }
      if (!task.baseSha && localSha !== baseSha) {
        throw new Error(`Refusing pre-existing unowned branch ${branch} at ${localSha}`);
      }
      const descendant = await this.git(['merge-base', '--is-ancestor', baseSha, localSha], this.repoRoot, false);
      if (descendant.exitCode !== 0) {
        throw new Error(`Existing branch ${branch} is not descended from task base ${baseSha}`);
      }
      await this.git(['worktree', 'add', target, branch], this.repoRoot);
    } else {
      const remoteBranch = await this.git(['ls-remote', '--exit-code', '--heads', 'origin', branch], this.repoRoot, false);
      if (remoteBranch.exitCode === 0) {
        const remoteSha = remoteBranch.stdout.trim().split(/\s+/)[0] ?? '';
        const expectedRemoteSha = task.commitSha ?? baseSha;
        if (remoteSha !== expectedRemoteSha) {
          throw new Error(`Refusing pre-existing unowned remote branch ${branch} at ${remoteSha}`);
        }
        await this.git(['fetch', 'origin', `${branch}:refs/heads/${branch}`], this.repoRoot);
        await this.git(['worktree', 'add', target, branch], this.repoRoot);
      } else {
        await this.git(['worktree', 'add', '-b', branch, target, baseSha], this.repoRoot);
      }
    }
    return { path: target, branch, baseSha, reused: false };
  }

  async changedFiles(worktree: string): Promise<string[]> {
    const receipt = await this.git(['status', '--porcelain=v1', '-z'], worktree);
    const tokens = receipt.stdout.split('\0');
    const files = new Set<string>();
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (!token) continue;
      const status = token.slice(0, 2);
      files.add(token.slice(3));
      if (status.includes('R') || status.includes('C')) {
        const original = tokens[index + 1];
        if (original) files.add(original);
        index += 1;
      }
    }
    return [...files];
  }

  async headSha(worktree: string): Promise<string> {
    return (await this.git(['rev-parse', 'HEAD'], worktree)).stdout.trim();
  }

  async isAncestor(worktree: string, ancestorSha: string, descendantSha: string): Promise<boolean> {
    const receipt = await this.git(['merge-base', '--is-ancestor', ancestorSha, descendantSha], worktree, false);
    return receipt.exitCode === 0;
  }

  async trackedChanges(worktree: string): Promise<string[]> {
    const entries = await this.statusEntries(worktree);
    return entries.filter((entry) => !entry.untracked).map((entry) => entry.path);
  }

  /** Tracked worktree entries with their exact porcelain v1 status codes. */
  async trackedCandidates(worktree: string): Promise<Array<{ path: string; status: string }>> {
    const entries = await this.statusEntries(worktree);
    return entries.filter((entry) => !entry.untracked)
      .map((entry) => ({ path: entry.path, status: entry.status }));
  }

  async untrackedFiles(worktree: string): Promise<string[]> {
    const entries = await this.statusEntries(worktree);
    return entries.filter((entry) => entry.untracked).map((entry) => entry.path);
  }

  /**
   * Fast-forward a task-owned implementation worktree whose local content is
   * limited to an untracked candidate plus optionally a set of disjoint
   * tracked candidate edits (ordinary unstaged modifications — porcelain
   * ' M' — of already-tracked regular
   * files). The exact untracked set must be declared up front and is
   * re-verified before and after the merge; every candidate byte (or symlink
   * target) is hashed on both sides so no drift can slip through. Tracked
   * candidates are likewise snapshotted (status, mode, SHA-256 bytes) on both
   * sides. Any other tracked status (staged or mixed modification, rename,
   * copy, conflict, typechange, submodule, symlink, addition, deletion) fails
   * closed. Repository hooks
   * are disabled for the merge via a verified nonexistent hooks path under
   * the harness-owned state root, so a hook cannot mutate the candidate between
   * the two verifications. No backup, delete, or reset is performed.
   */
  async advanceImplementationBase(
    worktree: string,
    previousSha: string,
    targetSha: string,
    expectedUntracked: string[],
    expectedTracked: string[] = [],
  ): Promise<void> {
    this.assertOwnedPath(worktree);
    if ((await this.headSha(worktree)) !== previousSha) {
      throw new Error(`Refusing implementation base advance: worktree HEAD moved away from ${previousSha}`);
    }
    const entries = await this.statusEntries(worktree);
    for (const entry of entries) {
      if (!entry.untracked && !isOrdinaryTrackedModification(entry.status)) {
        throw new Error(
          `Refusing implementation base advance over unsupported tracked change ${entry.path} (${entry.status.trim() || 'index'})`,
        );
      }
    }
    const tracked = entries.filter((entry) => !entry.untracked).map((entry) => entry.path).sort();
    const expectedTrackedList = [...expectedTracked].sort();
    if (tracked.length !== expectedTrackedList.length ||
        tracked.some((file, index) => file !== expectedTrackedList[index])) {
      throw new Error('Tracked candidate set changed before the implementation base advance');
    }
    const before = entries.filter((entry) => entry.untracked).map((entry) => entry.path).sort();
    const expected = [...expectedUntracked].sort();
    if (before.length !== expected.length || before.some((file, index) => file !== expected[index])) {
      throw new Error('Untracked candidate set changed before the implementation base advance');
    }
    const beforeDigests = this.untrackedDigests(worktree, before);
    const beforeTrackedDigests = this.trackedCandidateDigests(
      worktree,
      entries.filter((entry) => !entry.untracked),
    );
    const disabledHooksPath = path.join(this.stateRoot, 'disabled-hooks');
    // lstat (not existsSync) so a dangling symlink at the path also fails
    // closed: git would still resolve core.hooksPath through it.
    if (lstatSync(disabledHooksPath, { throwIfNoEntry: false }) !== undefined) {
      throw new Error(
        `Refusing implementation base advance: expected-absent hooks path ${disabledHooksPath} already exists`,
      );
    }
    await this.git(['-c', `core.hooksPath=${disabledHooksPath}`, 'merge', '--ff-only', targetSha], worktree);
    const mergedHead = await this.headSha(worktree);
    if (mergedHead !== targetSha) {
      throw new Error(`Fast-forward verification failed: HEAD is ${mergedHead}, expected ${targetSha}`);
    }
    const afterEntries = await this.statusEntries(worktree);
    const after = afterEntries.filter((entry) => entry.untracked).map((entry) => entry.path).sort();
    if (after.length !== before.length || after.some((file, index) => file !== before[index])) {
      throw new Error(`Fast-forward to ${targetSha} altered the untracked candidate set`);
    }
    const afterDigests = this.untrackedDigests(worktree, after);
    const drifted = after.filter((file) => afterDigests.get(file) !== beforeDigests.get(file));
    if (drifted.length > 0) {
      throw new Error(`Fast-forward to ${targetSha} altered untracked candidate bytes: ${drifted.join(', ')}`);
    }
    const afterTrackedEntries = afterEntries.filter((entry) => !entry.untracked);
    for (const entry of afterTrackedEntries) {
      if (!isOrdinaryTrackedModification(entry.status)) {
        throw new Error(
          `Fast-forward to ${targetSha} produced unsupported tracked change ${entry.path} (${entry.status.trim() || 'index'})`,
        );
      }
    }
    const afterTrackedSorted = afterTrackedEntries.map((entry) => entry.path).sort();
    if (afterTrackedSorted.length !== tracked.length ||
        afterTrackedSorted.some((file, index) => file !== tracked[index])) {
      throw new Error(`Fast-forward to ${targetSha} altered the tracked candidate set`);
    }
    const afterTrackedDigests = this.trackedCandidateDigests(worktree, afterTrackedEntries);
    const trackedDrift = tracked.filter((file) => {
      const beforeEntry = beforeTrackedDigests.get(file);
      const afterEntry = afterTrackedDigests.get(file);
      return beforeEntry === undefined || afterEntry === undefined ||
        beforeEntry.status !== afterEntry.status ||
        beforeEntry.mode !== afterEntry.mode ||
        beforeEntry.sha256 !== afterEntry.sha256;
    });
    if (trackedDrift.length > 0) {
      throw new Error(`Fast-forward to ${targetSha} altered tracked candidate bytes: ${trackedDrift.join(', ')}`);
    }
  }

  /** Compare a tracked blob at an exact commit against expected template bytes. */
  async blobMatches(worktree: string, commitSha: string, file: string, expected: Buffer): Promise<boolean> {
    const receipt = await this.git(['show', `${commitSha}:${file}`], worktree, false);
    if (receipt.exitCode !== 0) return false;
    return createHash('sha256').update(receipt.stdout, 'utf8').digest('hex') ===
      createHash('sha256').update(expected.toString('utf8'), 'utf8').digest('hex');
  }

  /**
   * Fast-forward a read-only evidence worktree to the current base. Hooks are
   * disabled through the same verified-nonexistent path used by
   * advanceImplementationBase, and the post-merge state is verified: HEAD must
   * land exactly on currentSha and the worktree must still be clean. This also
   * covers the crash-recovery call path, where a durable request already
   * exists and only the fast-forward is being replayed.
   */
  async advanceReadOnlyBase(worktree: string, previousSha: string, currentSha: string): Promise<void> {
    this.assertOwnedPath(worktree);
    if (await this.headSha(worktree) !== previousSha || (await this.changedFiles(worktree)).length > 0) {
      throw new Error('Refusing to advance read-only evidence over a changed worktree');
    }
    const disabledHooksPath = path.join(this.stateRoot, 'disabled-hooks');
    // lstat (not existsSync) so a dangling symlink at the path also fails
    // closed: git would still resolve core.hooksPath through it.
    if (lstatSync(disabledHooksPath, { throwIfNoEntry: false }) !== undefined) {
      throw new Error(
        `Refusing read-only base advance: expected-absent hooks path ${disabledHooksPath} already exists`,
      );
    }
    await this.git(['-c', `core.hooksPath=${disabledHooksPath}`, 'merge', '--ff-only', currentSha], worktree);
    const mergedHead = await this.headSha(worktree);
    if (mergedHead !== currentSha) {
      throw new Error(`Read-only base advance verification failed: HEAD is ${mergedHead}, expected ${currentSha}`);
    }
    const dirty = await this.changedFiles(worktree);
    if (dirty.length > 0) {
      throw new Error(`Read-only base advance verification failed: worktree changed during the merge: ${dirty.join(', ')}`);
    }
  }

  async filesChangedBetween(worktree: string, baseSha: string, headSha: string): Promise<string[]> {
    const receipt = await this.git(
      ['diff', '--name-status', '-z', '--find-renames', `${baseSha}..${headSha}`],
      worktree,
    );
    const tokens = receipt.stdout.split('\0');
    const files = new Set<string>();
    for (let index = 0; index < tokens.length;) {
      const status = tokens[index++];
      if (!status) continue;
      const first = tokens[index++];
      if (first) files.add(first);
      if (status.startsWith('R') || status.startsWith('C')) {
        const second = tokens[index++];
        if (second) files.add(second);
      }
    }
    return [...files];
  }

  async diff(worktree: string, baseSha: string, headSha = 'HEAD'): Promise<string> {
    return (await this.git(['diff', '--no-ext-diff', '--find-renames', `${baseSha}..${headSha}`], worktree)).stdout;
  }

  async createDetachedWorktree(sha: string, label: string): Promise<string> {
    const target = path.join(this.worktreesRoot, `verify-${safeSlug(label)}`);
    this.assertOwnedPath(target);
    if (existsSync(target)) {
      const current = (await this.git(['rev-parse', 'HEAD'], target)).stdout.trim();
      const status = await this.git(['status', '--porcelain=v1'], target, false);
      if (current === sha && status.exitCode === 0 && !status.stdout.trim()) return target;
      await this.removeOwnedWorktree(target, { allowDirty: true });
    }
    await this.git(['fetch', 'origin'], this.repoRoot);
    await this.git(['worktree', 'add', '--detach', target, sha], this.repoRoot);
    return target;
  }

  assertNoProtectedChanges(files: string[]): void {
    const violations = files.filter((file) =>
      this.config.protectedPaths.some((protectedPath) =>
        protectedPath.endsWith('/') ? file.startsWith(protectedPath) : file === protectedPath || file.startsWith(protectedPath),
      ),
    );
    if (violations.length > 0) {
      throw new Error(`Autonomous change touches protected governance paths: ${violations.join(', ')}`);
    }
  }

  async commitCandidate(worktree: string, task: TaskRecord, summary: string): Promise<string> {
    const files = await this.changedFiles(worktree);
    if (files.length > 0) {
      this.assertNoProtectedChanges(files);
      await this.git(['add', '--all', '--', '.'], worktree);
      const message = `harness: ${summary.slice(0, 68)}\n\nIssue: #${task.issueNumber}\nTask: ${task.id}`;
      await this.git(['commit', '-m', message], worktree, true, {
        ...process.env,
        GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'Fern Delivery Harness',
        GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'fern-delivery-harness@users.noreply.github.com',
        GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'Fern Delivery Harness',
        GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'fern-delivery-harness@users.noreply.github.com',
      });
    } else {
      const head = (await this.git(['rev-parse', 'HEAD'], worktree)).stdout.trim();
      if (!task.baseSha || head === task.baseSha) throw new Error('Qwen completed without producing a repository change');
      const message = (await this.git(['log', '-1', '--format=%B'], worktree)).stdout;
      if (!message.includes(`Task: ${task.id}`)) {
        throw new Error(`Refusing to resume commit ${head}: it is not marked as owned by task ${task.id}`);
      }
    }
    const sha = (await this.git(['rev-parse', 'HEAD'], worktree)).stdout.trim();
    return sha;
  }

  async pushCandidate(worktree: string, branch: string, sha: string): Promise<void> {
    const current = (await this.git(['rev-parse', 'HEAD'], worktree)).stdout.trim();
    if (current !== sha) throw new Error(`Worktree HEAD changed from candidate ${sha} to ${current}`);
    await this.git(['push', '--set-upstream', 'origin', branch], worktree);
    await this.verifyRemoteHead(branch, sha);
  }

  async commitAndPush(worktree: string, task: TaskRecord, summary: string): Promise<string> {
    const sha = await this.commitCandidate(worktree, task, summary);
    await this.pushCandidate(worktree, task.branch as string, sha);
    return sha;
  }

  async verifyRemoteHead(branch: string, expectedSha: string): Promise<void> {
    const receipt = await this.git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], this.repoRoot);
    const remoteSha = receipt.stdout.trim().split(/\s+/)[0];
    if (remoteSha !== expectedSha) {
      throw new Error(`Remote branch ${branch} is ${remoteSha || '<missing>'}; expected tested commit ${expectedSha}`);
    }
  }

  async removeOwnedWorktree(worktree: string, options: { allowDirty?: boolean } = {}): Promise<void> {
    this.assertOwnedPath(worktree);
    if (!options.allowDirty) {
      const status = await this.git(['status', '--porcelain=v1'], worktree, false);
      if (status.exitCode !== 0 || status.stdout.trim()) {
        throw new Error(`Refusing to remove non-clean harness worktree: ${worktree}`);
      }
    }
    await this.git(['worktree', 'remove', ...(options.allowDirty ? ['--force'] : []), worktree], this.repoRoot);
    await this.git(['worktree', 'prune'], this.repoRoot);
  }

  /**
   * Hash the exact bytes (or symlink target) of each declared untracked
   * candidate so byte-level drift fails closed. Anything that is not a regular
   * file or a symlink is refused.
   */
  protected untrackedDigests(worktree: string, files: string[]): Map<string, string> {
    const digests = new Map<string, string>();
    for (const file of files) {
      const absolute = path.join(worktree, file);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        digests.set(file, `symlink:${readlinkSync(absolute)}`);
      } else if (stat.isFile()) {
        digests.set(file, createHash('sha256').update(readFileSync(absolute)).digest('hex'));
      } else {
        throw new Error(`Untracked candidate entry ${file} is neither a regular file nor a symlink`);
      }
    }
    return digests;
  }

  /**
   * Narrowly scoped public snapshot of the exact untracked candidate bytes
   * (regular-file SHA-256 or symlink target), keyed by repository-relative
   * path. Callers persist this in durable request evidence and fail closed if
   * the reconciled bytes no longer match.
   */
  untrackedDigestSnapshot(worktree: string, files: string[]): Record<string, string> {
    return Object.fromEntries(this.untrackedDigests(worktree, [...files].sort()));
  }

  /**
   * Hash the porcelain status, filesystem mode, and exact bytes of each
   * tracked candidate edit so byte-level, mode, or status drift fails closed.
   * Only ordinary unstaged modifications of regular files are supported
   * (' M'); anything else (staged or mixed modification, symlink,
   * typechange, special file) is refused.
   */
  protected trackedCandidateDigests(
    worktree: string,
    entries: Array<{ path: string; status: string }>,
  ): Map<string, TrackedCandidateDigest> {
    const digests = new Map<string, TrackedCandidateDigest>();
    for (const entry of entries) {
      if (!isOrdinaryTrackedModification(entry.status)) {
        throw new Error(
          `Tracked candidate entry ${entry.path} is not an ordinary unstaged modification (${entry.status.trim() || 'index'})`,
        );
      }
      const absolute = path.join(worktree, entry.path);
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Tracked candidate entry ${entry.path} is not a regular file`);
      }
      digests.set(entry.path, {
        status: entry.status,
        mode: stat.mode,
        sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex'),
      });
    }
    return digests;
  }

  /**
   * Narrowly scoped public snapshot of the tracked candidate edits (status,
   * mode, SHA-256 bytes), keyed by repository-relative path. Callers persist
   * this in durable request evidence and fail closed if the reconciled
   * status, mode, or bytes no longer match.
   */
  trackedCandidateSnapshot(
    worktree: string,
    entries: Array<{ path: string; status: string }>,
  ): Record<string, TrackedCandidateDigest> {
    const sorted = [...entries].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    return Object.fromEntries(this.trackedCandidateDigests(worktree, sorted));
  }

  private async statusEntries(worktree: string): Promise<Array<{ untracked: boolean; path: string; status: string }>> {
    const receipt = await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], worktree);
    const tokens = receipt.stdout.split('\0');
    const entries: Array<{ untracked: boolean; path: string; status: string }> = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (!token) continue;
      const status = token.slice(0, 2);
      entries.push({ untracked: status === '??', path: token.slice(3), status });
      if (status.includes('R') || status.includes('C')) index += 1;
    }
    return entries;
  }

  private assertOwnedPath(target: string): void {
    const relative = path.relative(this.worktreesRoot, path.resolve(target));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Worktree path is outside the harness-owned root: ${target}`);
    }
  }

  private async git(
    args: string[],
    cwd: string,
    required = true,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<Awaited<ReturnType<typeof runProcess>>> {
    const options: ProcessOptions = {
      command: 'git',
      args,
      cwd,
      timeoutMs: 2 * 60_000,
      env: { ...env, GIT_TERMINAL_PROMPT: '0' },
    };
    const receipt = await runProcess(options);
    if (required && receipt.exitCode !== 0) throw new Error(formatProcessFailure(receipt));
    return receipt;
  }
}

export function branchFor(task: Pick<TaskRecord, 'issueNumber' | 'title'>): string {
  return `harness/issue-${task.issueNumber}-${safeSlug(task.title)}`.slice(0, 120);
}

export function githubSlugFromRemote(remote: string): string | null {
  const match = /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
    remote.trim(),
  );
  return match ? `${match[1]}/${match[2]}` : null;
}

function safeSlug(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || 'task';
}
