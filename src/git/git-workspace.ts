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

  async untrackedFiles(worktree: string): Promise<string[]> {
    const entries = await this.statusEntries(worktree);
    return entries.filter((entry) => entry.untracked).map((entry) => entry.path);
  }

  /**
   * Fast-forward a task-owned implementation worktree whose only content is an
   * untracked candidate. The exact untracked set must be declared up front and is
   * re-verified before and after the merge; every candidate byte (or symlink
   * target) is hashed on both sides so no drift can slip through. Repository
   * hooks are disabled for the merge via a verified nonexistent hooks path under
   * the harness-owned state root, so a hook cannot mutate the candidate between
   * the two verifications. No backup, delete, or reset is performed.
   */
  async advanceImplementationBase(
    worktree: string,
    previousSha: string,
    targetSha: string,
    expectedUntracked: string[],
  ): Promise<void> {
    this.assertOwnedPath(worktree);
    if ((await this.headSha(worktree)) !== previousSha) {
      throw new Error(`Refusing implementation base advance: worktree HEAD moved away from ${previousSha}`);
    }
    const entries = await this.statusEntries(worktree);
    const tracked = entries.filter((entry) => !entry.untracked).map((entry) => entry.path);
    if (tracked.length > 0) {
      throw new Error(`Refusing implementation base advance over tracked changes: ${tracked.join(', ')}`);
    }
    const before = entries.filter((entry) => entry.untracked).map((entry) => entry.path).sort();
    const expected = [...expectedUntracked].sort();
    if (before.length !== expected.length || before.some((file, index) => file !== expected[index])) {
      throw new Error('Untracked candidate set changed before the implementation base advance');
    }
    const beforeDigests = this.untrackedDigests(worktree, before);
    const disabledHooksPath = path.join(this.stateRoot, 'disabled-hooks');
    // lstat (not existsSync) so a dangling symlink at the path also fails
    // closed: git would still resolve core.hooksPath through it.
    if (lstatSync(disabledHooksPath, { throwIfNoEntry: false }) !== undefined) {
      throw new Error(
        `Refusing implementation base advance: expected-absent hooks path ${disabledHooksPath} already exists`,
      );
    }
    await this.git(['-c', `core.hooksPath=${disabledHooksPath}`, 'merge', '--ff-only', targetSha], worktree);
    const after = (await this.statusEntries(worktree)).filter((entry) => entry.untracked).map((entry) => entry.path).sort();
    if (after.length !== before.length || after.some((file, index) => file !== before[index])) {
      throw new Error(`Fast-forward to ${targetSha} altered the untracked candidate set`);
    }
    const afterDigests = this.untrackedDigests(worktree, after);
    const drifted = after.filter((file) => afterDigests.get(file) !== beforeDigests.get(file));
    if (drifted.length > 0) {
      throw new Error(`Fast-forward to ${targetSha} altered untracked candidate bytes: ${drifted.join(', ')}`);
    }
  }

  /** Compare a tracked blob at an exact commit against expected template bytes. */
  async blobMatches(worktree: string, commitSha: string, file: string, expected: Buffer): Promise<boolean> {
    const receipt = await this.git(['show', `${commitSha}:${file}`], worktree, false);
    if (receipt.exitCode !== 0) return false;
    return createHash('sha256').update(receipt.stdout, 'utf8').digest('hex') ===
      createHash('sha256').update(expected.toString('utf8'), 'utf8').digest('hex');
  }

  async advanceReadOnlyBase(worktree: string, previousSha: string, currentSha: string): Promise<void> {
    this.assertOwnedPath(worktree);
    if (await this.headSha(worktree) !== previousSha || (await this.changedFiles(worktree)).length > 0) {
      throw new Error('Refusing to advance read-only evidence over a changed worktree');
    }
    await this.git(['merge', '--ff-only', currentSha], worktree);
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

  private async statusEntries(worktree: string): Promise<Array<{ untracked: boolean; path: string }>> {
    const receipt = await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], worktree);
    const tokens = receipt.stdout.split('\0');
    const entries: Array<{ untracked: boolean; path: string }> = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (!token) continue;
      const status = token.slice(0, 2);
      entries.push({ untracked: status === '??', path: token.slice(3) });
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
