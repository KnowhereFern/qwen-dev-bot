import { existsSync, mkdirSync, realpathSync } from 'node:fs';
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

  constructor(
    root: string,
    stateDir: string,
    private readonly config: ProjectConfig,
  ) {
    this.repoRoot = realpathSync(root);
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
