import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

  it('enumerates only an exact first-parent range across a merge', async () => {
    const { repo } = await createGitFixture();
    const git = new GitWorkspace(repo, makeTmp('git-first-parent-state'), defaultProjectConfig(repo, 'fixture', 'owner/fixture'));
    const base = await command(['rev-parse', 'HEAD'], repo);
    writeFileSync(path.join(repo, 'main-change.txt'), 'main\n');
    await command(['add', 'main-change.txt'], repo);
    await command(['commit', '-m', 'main change'], repo);
    const mainCommit = await command(['rev-parse', 'HEAD'], repo);
    await command(['checkout', '-b', 'side', base], repo);
    writeFileSync(path.join(repo, 'side-change.txt'), 'side\n');
    await command(['add', 'side-change.txt'], repo);
    await command(['commit', '-m', 'side change'], repo);
    const sideCommit = await command(['rev-parse', 'HEAD'], repo);
    await command(['checkout', 'main'], repo);
    await command(['merge', '--no-ff', 'side', '-m', 'merge side'], repo);
    const mergeCommit = await command(['rev-parse', 'HEAD'], repo);

    expect(await git.firstParentRange(repo, base, mergeCommit)).toEqual([mainCommit, mergeCommit]);
    expect(await git.firstParentRange(repo, sideCommit, mergeCommit)).toEqual([]);
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

  it('advances an implementation base without running repository hooks and preserves candidate bytes', async () => {
    const { repo } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    const git = new GitWorkspace(repo, makeTmp('git-impl-advance-state'), config);
    const task = taskRecord();
    task.branch = branchFor(task);
    const worktree = await git.createOrResume(task);
    task.baseSha = worktree.baseSha;
    mkdirSync(path.join(worktree.path, 'src'), { recursive: true });
    writeFileSync(path.join(worktree.path, 'src', 'genotype-store.ts'), 'export {};\n');
    const candidateBytes = 'export {};\n';

    // A hostile repository hook must not run during the fast-forward.
    mkdirSync(path.join(repo, '.git', 'hooks'), { recursive: true });
    const hook = path.join(repo, '.git', 'hooks', 'post-merge');
    writeFileSync(
      hook,
      '#!/bin/sh\nprintf "hook ran\\n" > hook-ran.txt\nprintf "hook touched\\n" >> src/genotype-store.ts\n',
    );
    chmodSync(hook, 0o755);

    mkdirSync(path.join(repo, '.qwen-harness', 'scripts'), { recursive: true });
    writeFileSync(path.join(repo, '.qwen-harness', 'scripts', 'run-gates.mjs'), 'export const gates = 1;\n');
    await command(['add', '.'], repo);
    await command(['commit', '-m', 'controller asset update'], repo);
    const target = await command(['rev-parse', 'HEAD'], repo);

    await git.advanceImplementationBase(worktree.path, task.baseSha, target, ['src/genotype-store.ts']);

    expect(await git.headSha(worktree.path)).toBe(target);
    expect(await git.untrackedFiles(worktree.path)).toEqual(['src/genotype-store.ts']);
    expect(await git.trackedChanges(worktree.path)).toEqual([]);
    expect(readFileSync(path.join(worktree.path, 'src', 'genotype-store.ts'), 'utf8')).toBe(candidateBytes);
    expect(existsSync(path.join(worktree.path, 'hook-ran.txt'))).toBe(false);
    await expect(
      git.advanceImplementationBase(worktree.path, task.baseSha, target, ['src/genotype-store.ts']),
    ).rejects.toThrow('HEAD moved');
    await expect(
      git.advanceImplementationBase(worktree.path, target, target, []),
    ).rejects.toThrow('Untracked candidate set changed');
    await git.removeOwnedWorktree(worktree.path, { allowDirty: true });
  });

  it('advances over disjoint tracked and untracked candidates and preserves exact tracked bytes', async () => {
    const { repo } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    const git = new GitWorkspace(repo, makeTmp('git-impl-tracked-state'), config);
    const task = taskRecord();
    task.branch = branchFor(task);
    const worktree = await git.createOrResume(task);
    task.baseSha = worktree.baseSha;
    mkdirSync(path.join(worktree.path, 'src'), { recursive: true });
    writeFileSync(path.join(worktree.path, 'src', 'genotype-store.ts'), 'export {};\n');
    const readmePath = path.join(worktree.path, 'README.md');
    writeFileSync(readmePath, `${readFileSync(readmePath, 'utf8')}local blocker note\n`);

    mkdirSync(path.join(repo, '.qwen-harness', 'scripts'), { recursive: true });
    writeFileSync(path.join(repo, '.qwen-harness', 'scripts', 'run-gates.mjs'), 'export const gates = 1;\n');
    await command(['add', '.'], repo);
    await command(['commit', '-m', 'controller asset update'], repo);
    const target = await command(['rev-parse', 'HEAD'], repo);

    const trackedBefore = await git.trackedCandidates(worktree.path);
    expect(trackedBefore).toEqual([{ path: 'README.md', status: ' M' }]);
    const snapshot = git.trackedCandidateSnapshot(worktree.path, trackedBefore);
    expect(snapshot['README.md']).toMatchObject({ status: ' M' });
    expect(snapshot['README.md']?.sha256).toMatch(/^[0-9a-f]{64}$/);

    await git.advanceImplementationBase(worktree.path, task.baseSha, target, ['src/genotype-store.ts'], ['README.md']);

    expect(await git.headSha(worktree.path)).toBe(target);
    expect(await git.trackedCandidates(worktree.path)).toEqual([{ path: 'README.md', status: ' M' }]);
    expect(git.trackedCandidateSnapshot(worktree.path, await git.trackedCandidates(worktree.path))).toEqual(snapshot);
    expect(readFileSync(readmePath, 'utf8')).toContain('local blocker note');
    expect(readFileSync(path.join(worktree.path, 'src', 'genotype-store.ts'), 'utf8')).toBe('export {};\n');
    await git.removeOwnedWorktree(worktree.path, { allowDirty: true });
  });

  it('refuses unsupported tracked changes such as deletions and renames during a base advance', async () => {
    const { repo } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    const git = new GitWorkspace(repo, makeTmp('git-impl-unsupported-state'), config);
    const task = taskRecord();
    task.branch = branchFor(task);
    const worktree = await git.createOrResume(task);
    task.baseSha = worktree.baseSha;
    writeFileSync(path.join(worktree.path, 'candidate.ts'), 'export const original = 1;\n');

    mkdirSync(path.join(repo, '.qwen-harness', 'scripts'), { recursive: true });
    writeFileSync(path.join(repo, '.qwen-harness', 'scripts', 'run-gates.mjs'), 'export const gates = 1;\n');
    await command(['add', '.'], repo);
    await command(['commit', '-m', 'controller asset update'], repo);
    const target = await command(['rev-parse', 'HEAD'], repo);

    rmSync(path.join(worktree.path, 'README.md'));
    await expect(
      git.advanceImplementationBase(worktree.path, task.baseSha, target, ['candidate.ts'], ['README.md']),
    ).rejects.toThrow('unsupported tracked change');
    expect(await git.headSha(worktree.path)).toBe(task.baseSha);

    await command(['checkout', '--', '.'], worktree.path);
    renameSync(path.join(worktree.path, 'AUTONOMY.md'), path.join(worktree.path, 'moved-contract.md'));
    await expect(
      git.advanceImplementationBase(worktree.path, task.baseSha, target, ['candidate.ts'], ['AUTONOMY.md', 'moved-contract.md']),
    ).rejects.toThrow('unsupported tracked change');
    expect(await git.headSha(worktree.path)).toBe(task.baseSha);
    await git.removeOwnedWorktree(worktree.path, { allowDirty: true });
  });

  it('refuses staged and mixed tracked modifications during a base advance', async () => {
    const { repo } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    const git = new GitWorkspace(repo, makeTmp('git-impl-staged-state'), config);
    const task = taskRecord();
    task.branch = branchFor(task);
    const worktree = await git.createOrResume(task);
    task.baseSha = worktree.baseSha;
    writeFileSync(path.join(worktree.path, 'candidate.ts'), 'export const original = 1;\n');
    const readmePath = path.join(worktree.path, 'README.md');
    const readmeBase = readFileSync(readmePath, 'utf8');

    mkdirSync(path.join(repo, '.qwen-harness', 'scripts'), { recursive: true });
    writeFileSync(path.join(repo, '.qwen-harness', 'scripts', 'run-gates.mjs'), 'export const gates = 1;\n');
    await command(['add', '.'], repo);
    await command(['commit', '-m', 'controller asset update'], repo);
    const target = await command(['rev-parse', 'HEAD'], repo);

    // A staged 'M ' modification is outside the supported base-advance
    // state and must fail closed.
    writeFileSync(readmePath, `${readmeBase}staged blocker note\n`);
    await command(['add', 'README.md'], worktree.path);
    expect(await git.trackedCandidates(worktree.path)).toEqual([{ path: 'README.md', status: 'M ' }]);
    await expect(
      git.advanceImplementationBase(worktree.path, task.baseSha, target, ['candidate.ts'], ['README.md']),
    ).rejects.toThrow('unsupported tracked change');
    expect(await git.headSha(worktree.path)).toBe(task.baseSha);

    // A further unstaged edit on top ('MM') is still not the documented
    // state and must likewise refuse.
    writeFileSync(readmePath, `${readmeBase}staged blocker note\nplus unstaged drift\n`);
    expect(await git.trackedCandidates(worktree.path)).toEqual([{ path: 'README.md', status: 'MM' }]);
    await expect(
      git.advanceImplementationBase(worktree.path, task.baseSha, target, ['candidate.ts'], ['README.md']),
    ).rejects.toThrow('unsupported tracked change');
    expect(await git.headSha(worktree.path)).toBe(task.baseSha);
    await git.removeOwnedWorktree(worktree.path, { allowDirty: true });
  });

  it('fails closed when tracked candidate bytes drift across the fast-forward', async () => {
    const { repo } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    class TrackedDriftWorkspace extends GitWorkspace {
      private digestCalls = 0;

      protected override trackedCandidateDigests(
        worktree: string,
        entries: Array<{ path: string; status: string }>,
      ): Map<string, import('../src/git/git-workspace.js').TrackedCandidateDigest> {
        this.digestCalls += 1;
        const digests = super.trackedCandidateDigests(worktree, entries);
        if (this.digestCalls === 2) {
          // Simulate the tracked candidate being mutated while the merge runs.
          const first = entries[0] as { path: string; status: string };
          digests.set(first.path, { ...(digests.get(first.path) as import('../src/git/git-workspace.js').TrackedCandidateDigest), sha256: 'drifted-bytes' });
        }
        return digests;
      }
    }
    const git = new TrackedDriftWorkspace(repo, makeTmp('git-impl-tracked-drift-state'), config);
    const task = taskRecord();
    task.branch = branchFor(task);
    const worktree = await git.createOrResume(task);
    task.baseSha = worktree.baseSha;
    writeFileSync(path.join(worktree.path, 'candidate.ts'), 'export const original = 1;\n');
    const readmePath = path.join(worktree.path, 'README.md');
    writeFileSync(readmePath, `${readFileSync(readmePath, 'utf8')}local blocker note\n`);

    mkdirSync(path.join(repo, '.qwen-harness', 'scripts'), { recursive: true });
    writeFileSync(path.join(repo, '.qwen-harness', 'scripts', 'run-gates.mjs'), 'export const gates = 1;\n');
    await command(['add', '.'], repo);
    await command(['commit', '-m', 'controller asset update'], repo);
    const target = await command(['rev-parse', 'HEAD'], repo);

    await expect(
      git.advanceImplementationBase(worktree.path, task.baseSha, target, ['candidate.ts'], ['README.md']),
    ).rejects.toThrow('altered tracked candidate bytes');
    await git.removeOwnedWorktree(worktree.path, { allowDirty: true });
  });

  it('fails closed when untracked candidate bytes drift across the fast-forward', async () => {
    const { repo } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    class ByteDriftWorkspace extends GitWorkspace {
      private digestCalls = 0;

      protected override untrackedDigests(worktree: string, files: string[]): Map<string, string> {
        this.digestCalls += 1;
        const digests = super.untrackedDigests(worktree, files);
        if (this.digestCalls === 2) {
          // Simulate the candidate being mutated while the merge runs.
          digests.set(files[0] as string, 'drifted-bytes');
        }
        return digests;
      }
    }
    const git = new ByteDriftWorkspace(repo, makeTmp('git-impl-drift-state'), config);
    const task = taskRecord();
    task.branch = branchFor(task);
    const worktree = await git.createOrResume(task);
    task.baseSha = worktree.baseSha;
    writeFileSync(path.join(worktree.path, 'candidate.ts'), 'export const original = 1;\n');

    mkdirSync(path.join(repo, '.qwen-harness', 'scripts'), { recursive: true });
    writeFileSync(path.join(repo, '.qwen-harness', 'scripts', 'run-gates.mjs'), 'export const gates = 1;\n');
    await command(['add', '.'], repo);
    await command(['commit', '-m', 'controller asset update'], repo);
    const target = await command(['rev-parse', 'HEAD'], repo);

    await expect(
      git.advanceImplementationBase(worktree.path, task.baseSha, target, ['candidate.ts']),
    ).rejects.toThrow('altered untracked candidate bytes');
    await git.removeOwnedWorktree(worktree.path, { allowDirty: true });
  });

  it('preserves untracked symlink candidates across an implementation base advance', async () => {
    const { repo } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    const git = new GitWorkspace(repo, makeTmp('git-impl-symlink-state'), config);
    const task = taskRecord();
    task.branch = branchFor(task);
    const worktree = await git.createOrResume(task);
    task.baseSha = worktree.baseSha;
    writeFileSync(path.join(worktree.path, 'candidate.ts'), 'export const original = 1;\n');
    symlinkSync('candidate.ts', path.join(worktree.path, 'link.ts'));

    mkdirSync(path.join(repo, '.qwen-harness', 'scripts'), { recursive: true });
    writeFileSync(path.join(repo, '.qwen-harness', 'scripts', 'run-gates.mjs'), 'export const gates = 1;\n');
    await command(['add', '.'], repo);
    await command(['commit', '-m', 'controller asset update'], repo);
    const target = await command(['rev-parse', 'HEAD'], repo);

    await git.advanceImplementationBase(worktree.path, task.baseSha, target, ['candidate.ts', 'link.ts']);

    expect(readlinkSync(path.join(worktree.path, 'link.ts'))).toBe('candidate.ts');
    expect(await git.untrackedFiles(worktree.path)).toEqual(['candidate.ts', 'link.ts']);
    await git.removeOwnedWorktree(worktree.path, { allowDirty: true });
  });

  it('fails closed when the disabled-hooks path is a dangling symlink', async () => {
    const { repo } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    const state = makeTmp('git-impl-dangling-hooks-state');
    const git = new GitWorkspace(repo, state, config);
    const task = taskRecord();
    task.branch = branchFor(task);
    const worktree = await git.createOrResume(task);
    task.baseSha = worktree.baseSha;
    writeFileSync(path.join(worktree.path, 'candidate.ts'), 'export const original = 1;\n');

    mkdirSync(path.join(repo, '.qwen-harness', 'scripts'), { recursive: true });
    writeFileSync(path.join(repo, '.qwen-harness', 'scripts', 'run-gates.mjs'), 'export const gates = 1;\n');
    await command(['add', '.'], repo);
    await command(['commit', '-m', 'controller asset update'], repo);
    const target = await command(['rev-parse', 'HEAD'], repo);

    // A dangling symlink at the hooks path would defeat an existsSync guard
    // (existsSync follows the link and reports false), so the lstat check must
    // refuse the advance instead of letting git resolve hooks through it.
    const disabledHooks = path.join(state, 'disabled-hooks');
    symlinkSync(path.join(state, 'nonexistent-hooks-target'), disabledHooks);
    expect(existsSync(disabledHooks)).toBe(false);

    await expect(
      git.advanceImplementationBase(worktree.path, task.baseSha, target, ['candidate.ts']),
    ).rejects.toThrow('already exists');
    expect(await git.headSha(worktree.path)).toBe(task.baseSha);
    await git.removeOwnedWorktree(worktree.path, { allowDirty: true });
  });

  it('advances a read-only base without running repository hooks and verifies the post-merge state', async () => {
    const { repo } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    const git = new GitWorkspace(repo, makeTmp('git-readonly-advance-state'), config);
    const task = taskRecord();
    task.branch = branchFor(task);
    const worktree = await git.createOrResume(task);
    task.baseSha = worktree.baseSha;

    // A hostile repository hook must not run during the read-only fast-forward.
    mkdirSync(path.join(repo, '.git', 'hooks'), { recursive: true });
    const hook = path.join(repo, '.git', 'hooks', 'post-merge');
    writeFileSync(
      hook,
      '#!/bin/sh\nprintf "hook ran\\n" > hook-ran.txt\nprintf "hook touched\\n" >> README.md\n',
    );
    chmodSync(hook, 0o755);

    writeFileSync(path.join(repo, 'remote-evidence.txt'), 'merged evidence\n');
    await command(['add', '.'], repo);
    await command(['commit', '-m', 'remote evidence update'], repo);
    const target = await command(['rev-parse', 'HEAD'], repo);

    await git.advanceReadOnlyBase(worktree.path, task.baseSha, target);

    expect(await git.headSha(worktree.path)).toBe(target);
    expect(await git.changedFiles(worktree.path)).toEqual([]);
    expect(existsSync(path.join(worktree.path, 'hook-ran.txt'))).toBe(false);
    expect(readFileSync(path.join(worktree.path, 'README.md'), 'utf8')).not.toContain('hook touched');
    await git.removeOwnedWorktree(worktree.path, { allowDirty: true });
  });

  it('fails closed when the worktree is dirty after a read-only base advance merge', async () => {
    const { repo } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    class DirtyAfterMergeWorkspace extends GitWorkspace {
      private changedCalls = 0;

      override async changedFiles(worktree: string): Promise<string[]> {
        this.changedCalls += 1;
        // First call is the pre-merge guard; second is post-merge verification.
        return this.changedCalls >= 2 ? ['unexpected-drift.txt'] : super.changedFiles(worktree);
      }
    }
    const git = new DirtyAfterMergeWorkspace(repo, makeTmp('git-readonly-drift-state'), config);
    const task = taskRecord();
    task.branch = branchFor(task);
    const worktree = await git.createOrResume(task);
    task.baseSha = worktree.baseSha;

    writeFileSync(path.join(repo, 'remote-evidence.txt'), 'merged evidence\n');
    await command(['add', '.'], repo);
    await command(['commit', '-m', 'remote evidence update'], repo);
    const target = await command(['rev-parse', 'HEAD'], repo);

    await expect(
      git.advanceReadOnlyBase(worktree.path, task.baseSha, target),
    ).rejects.toThrow('worktree changed during the merge');
    expect(await git.headSha(worktree.path)).toBe(target);
    await git.removeOwnedWorktree(worktree.path, { allowDirty: true });
  });

  it('fails closed when the disabled-hooks path blocks a read-only base advance', async () => {
    const { repo } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    const state = makeTmp('git-readonly-hooks-state');
    const git = new GitWorkspace(repo, state, config);
    const task = taskRecord();
    task.branch = branchFor(task);
    const worktree = await git.createOrResume(task);
    task.baseSha = worktree.baseSha;

    writeFileSync(path.join(repo, 'remote-evidence.txt'), 'merged evidence\n');
    await command(['add', '.'], repo);
    await command(['commit', '-m', 'remote evidence update'], repo);
    const target = await command(['rev-parse', 'HEAD'], repo);

    const disabledHooks = path.join(state, 'disabled-hooks');
    symlinkSync(path.join(state, 'nonexistent-hooks-target'), disabledHooks);
    await expect(
      git.advanceReadOnlyBase(worktree.path, task.baseSha, target),
    ).rejects.toThrow('already exists');
    expect(await git.headSha(worktree.path)).toBe(task.baseSha);
    await git.removeOwnedWorktree(worktree.path, { allowDirty: true });
  });

  it('exposes an untracked digest snapshot that rejects non-file candidates', async () => {
    const { repo } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    const git = new GitWorkspace(repo, makeTmp('git-digest-snapshot-state'), config);
    const task = taskRecord();
    task.branch = branchFor(task);
    const worktree = await git.createOrResume(task);
    task.baseSha = worktree.baseSha;
    writeFileSync(path.join(worktree.path, 'candidate.ts'), 'export const original = 1;\n');
    symlinkSync('candidate.ts', path.join(worktree.path, 'link.ts'));
    mkdirSync(path.join(worktree.path, 'candidate-dir'));

    const snapshot = git.untrackedDigestSnapshot(worktree.path, ['link.ts', 'candidate.ts']);
    expect(Object.keys(snapshot).sort()).toEqual(['candidate.ts', 'link.ts']);
    expect(snapshot['link.ts']).toBe('symlink:candidate.ts');
    expect(snapshot['candidate.ts']).toMatch(/^[0-9a-f]{64}$/);
    expect(() => git.untrackedDigestSnapshot(worktree.path, ['candidate-dir'])).toThrow(
      'neither a regular file nor a symlink',
    );
    await git.removeOwnedWorktree(worktree.path, { allowDirty: true });
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
