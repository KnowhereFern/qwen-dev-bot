import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultProjectConfig } from '../src/core/config.js';
import type { TaskRecord } from '../src/core/types.js';
import { GitWorkspace, branchFor, githubSlugFromRemote } from '../src/git/git-workspace.js';
import { runProcess } from '../src/runtime/safe-process.js';
import { createGitFixture } from './fixtures/git.js';
import { makeTmp } from './helpers.js';

describe('real Git worktree delivery', () => {
  it('normalizes supported GitHub origin URL forms', () => {
    expect(githubSlugFromRemote('https://github.com/Owner/Repo.git')).toBe('Owner/Repo');
    expect(githubSlugFromRemote('git@github.com:owner/repo.git')).toBe('owner/repo');
    expect(githubSlugFromRemote('ssh://git@github.com/owner/repo')).toBe('owner/repo');
    expect(githubSlugFromRemote('https://gitlab.com/owner/repo.git')).toBeNull();
  });

  it('creates an isolated branch, commits, pushes, and verifies the exact remote head', async () => {
    const { repo, remote } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    const git = new GitWorkspace(repo, makeTmp('git-state'), config);
    await git.assertReady();
    const task = taskRecord();
    task.branch = branchFor(task);
    const worktree = await git.createOrResume(task);
    task.baseSha = worktree.baseSha;
    task.worktreePath = worktree.path;
    writeFileSync(path.join(worktree.path, 'feature.txt'), 'delivered\n');
    const sha = await git.commitAndPush(worktree.path, task, 'deliver fixture');
    const remoteHead = await command(['--git-dir', remote, 'rev-parse', task.branch], repo);
    expect(remoteHead).toBe(sha);
    expect(await git.diff(worktree.path, worktree.baseSha, sha)).toContain('feature.txt');
    await git.removeOwnedWorktree(worktree.path);
  });

  it('resumes an already-pushed task commit after a persistence crash window', async () => {
    const { repo } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    const git = new GitWorkspace(repo, makeTmp('git-resume-commit'), config);
    const task = taskRecord();
    task.branch = branchFor(task);
    const worktree = await git.createOrResume(task);
    task.baseSha = worktree.baseSha;
    writeFileSync(path.join(worktree.path, 'feature.txt'), 'recoverable\n');

    const firstSha = await git.commitAndPush(worktree.path, task, 'recoverable fixture');
    const resumedSha = await git.commitAndPush(worktree.path, task, 'ignored after recovery');

    expect(resumedSha).toBe(firstSha);
    await git.removeOwnedWorktree(worktree.path);
  });

  it('rejects a pre-created remote task branch that is not the persisted candidate', async () => {
    const { repo } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    const state = makeTmp('git-hostile-branch-state');
    const task = taskRecord();
    task.branch = branchFor(task);
    await command(['checkout', '-b', task.branch], repo);
    writeFileSync(path.join(repo, 'foreign.txt'), 'not owned by the harness\n');
    await command(['add', 'foreign.txt'], repo);
    await command(['commit', '-m', 'foreign branch content'], repo);
    await command(['push', 'origin', task.branch], repo);
    await command(['checkout', 'main'], repo);
    await command(['branch', '-D', task.branch], repo);

    const git = new GitWorkspace(repo, state, config);
    await expect(git.createOrResume(task)).rejects.toThrow('unowned remote branch');
  });

  it('detects both sides of a protected-file rename', async () => {
    const { repo } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    const git = new GitWorkspace(repo, makeTmp('git-rename-state'), config);
    const task = taskRecord();
    task.branch = branchFor(task);
    const worktree = await git.createOrResume(task);
    renameSync(path.join(worktree.path, 'AUTONOMY.md'), path.join(worktree.path, 'moved-contract.md'));
    const changed = await git.changedFiles(worktree.path);
    expect(changed).toContain('AUTONOMY.md');
    expect(changed).toContain('moved-contract.md');
    expect(() => git.assertNoProtectedChanges(changed)).toThrow('AUTONOMY.md');
  });

  it('blocks an untrusted protected-file rename in the GitHub governance check', async () => {
    const { repo } = await createGitFixture();
    mkdirSync(path.join(repo, '.qwen-harness'));
    writeFileSync(
      path.join(repo, '.qwen-harness', 'project.yml'),
      `${JSON.stringify({ protectedPaths: ['AUTONOMY.md'], intake: { trustedAuthors: ['trusted-owner'] } })}\n`,
    );
    await command(['add', '.qwen-harness/project.yml'], repo);
    await command(['commit', '-m', 'add governance config'], repo);
    const base = await command(['rev-parse', 'HEAD'], repo);
    renameSync(path.join(repo, 'AUTONOMY.md'), path.join(repo, 'moved-contract.md'));
    await command(['add', '--all'], repo);
    await command(['commit', '-m', 'rename protected contract'], repo);
    const head = await command(['rev-parse', 'HEAD'], repo);
    const script = path.resolve('template/.qwen-harness/scripts/check-governance.mjs');
    const receipt = await runProcess({
      command: process.execPath,
      args: [script],
      cwd: repo,
      env: { ...process.env, BASE_SHA: base, HEAD_SHA: head, PR_AUTHOR: 'untrusted-user' },
      timeoutMs: 20_000,
    });
    expect(receipt.exitCode).toBe(1);
    expect(receipt.stderr).toContain('AUTONOMY.md');
  });

  it('removes a dirty disposable verification worktree without weakening implementation cleanup', async () => {
    const { repo } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    const git = new GitWorkspace(repo, makeTmp('git-verification-cleanup'), config);
    const sha = await command(['rev-parse', 'HEAD'], repo);
    const verification = await git.createDetachedWorktree(sha, 'dirty-gate-output');
    writeFileSync(path.join(verification, 'generated-by-gate.txt'), 'disposable\n');

    await expect(git.removeOwnedWorktree(verification)).rejects.toThrow('non-clean');
    await git.removeOwnedWorktree(verification, { allowDirty: true });
    expect(existsSync(verification)).toBe(false);
  });
});

export function taskRecord(): TaskRecord {
  return {
    id: 'task-fixture', projectId: 'fixture', issueNumber: 2, title: 'Add feature', body: '', labels: [], author: 'bot',
    state: 'leased', spec: null, priority: 0, attempts: 0, identicalFailures: 0, lastFailureFingerprint: null,
    maxAttempts: 5, leaseOwner: 'worker', leaseExpiresAt: Date.now() + 10_000, baseSha: null, branch: null,
    worktreePath: null, commitSha: null, qwenSessionId: null, qwenWorkflowRunId: null, prNumber: null,
    prUrl: null, mergeSha: null, rewardRunId: null, lastError: null, createdAt: Date.now(), updatedAt: Date.now(), version: 1,
  };
}

async function command(args: string[], cwd: string): Promise<string> {
  const result = await runProcess({ command: 'git', args, cwd, timeoutMs: 20_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
