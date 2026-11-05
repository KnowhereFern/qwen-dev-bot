import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultProjectConfig } from '../src/core/config.js';
import {
  assertChangedFilesWithinScope,
  isPathWithinScope,
  parseChangeScopeMarker,
} from '../src/core/change-scope.js';
import type { TaskRecord, TaskSpec } from '../src/core/types.js';
import { GitWorkspace, branchFor } from '../src/git/git-workspace.js';
import { enforceTaskChangeScope } from '../src/supervisor.js';
import { runProcess } from '../src/runtime/safe-process.js';
import { createGitFixture } from './fixtures/git.js';
import { taskRecord } from './git-workspace.test.js';
import { makeTmp } from './helpers.js';

function scopedTask(constraints: string[]): TaskRecord {
  const spec: TaskSpec = {
    goal: 'Composite Skill Registry resolution',
    source: { kind: 'user', author: 'trusted-owner' },
    acceptanceCriteria: ['Skill Registry resolves composite skills end to end.'],
    constraints,
    requiredGateIds: [],
    rewardCriterionIds: [],
    risk: 'medium',
    dependencies: [],
    rollback: 'Revert the task commit.',
    technologyDecisions: [],
    deploymentDecisions: [],
  };
  return { ...taskRecord(), spec };
}

describe('change scope marker parsing', () => {
  it('parses exact files and directory prefixes', () => {
    expect(parseChangeScopeMarker(['Change scope: src/a.ts, src/b.ts, test/'])).toEqual([
      'src/a.ts',
      'src/b.ts',
      'test/',
    ]);
  });

  it('returns null without a marker and never infers scope from prose', () => {
    expect(parseChangeScopeMarker([])).toBeNull();
    expect(parseChangeScopeMarker(null)).toBeNull();
    expect(parseChangeScopeMarker(undefined)).toBeNull();
    expect(parseChangeScopeMarker(['Keep the change scope small.'])).toBeNull();
    expect(parseChangeScopeMarker(['change scope: src/a.ts'])).toBeNull();
    expect(parseChangeScopeMarker(['Stay within the change scope: src/ when possible'])).toBeNull();
    expect(parseChangeScopeMarker(['Shared TOKEN-CULLING constraint is an invariant.'])).toBeNull();
  });

  it('rejects malformed markers', () => {
    expect(() => parseChangeScopeMarker(['Change scope:'])).toThrow('Malformed Change scope marker');
    expect(() => parseChangeScopeMarker(['Change scope:   '])).toThrow('no paths');
    expect(() => parseChangeScopeMarker(['Change scope: src/a.ts, , src/b.ts'])).toThrow('empty path');
    expect(() => parseChangeScopeMarker(['Change scope: /etc/passwd'])).toThrow('absolute');
    expect(() => parseChangeScopeMarker(['Change scope: C:\\repo\\src'])).toThrow('backslashes');
    expect(() => parseChangeScopeMarker(['Change scope: src/../outside.ts'])).toThrow("'.' or '..'");
    expect(() => parseChangeScopeMarker(['Change scope: src//outside.ts'])).toThrow('empty segment');
    expect(() => parseChangeScopeMarker(['Change scope: *'])).toThrow('glob');
    expect(() => parseChangeScopeMarker(['Change scope: *.ts'])).toThrow('glob');
    expect(() => parseChangeScopeMarker(['Change scope: src/, src/'])).toThrow('more than once');
    expect(() => parseChangeScopeMarker(['Change scope: src/a.ts', 'Change scope: test/'])).toThrow(
      'conflicting',
    );
  });
});

describe('change scope matching and enforcement', () => {
  const scope = ['src/registry.ts', 'test/registry.test.ts', 'src/skills/'];

  it('allows exact files and directory-prefixed paths', () => {
    expect(isPathWithinScope('src/registry.ts', scope)).toBe(true);
    expect(isPathWithinScope('test/registry.test.ts', scope)).toBe(true);
    expect(isPathWithinScope('src/skills/resolver.ts', scope)).toBe(true);
    expect(isPathWithinScope('src/skills/nested/deep.ts', scope)).toBe(true);
    expect(isPathWithinScope('src/phenotype-store.ts', scope)).toBe(false);
    expect(isPathWithinScope('src/registry.ts.bak', scope)).toBe(false);
    expect(assertChangedFilesWithinScope(['src/registry.ts', 'src/skills/resolver.ts'], scope, 'test')).toBeUndefined();
  });

  it('rejects out-of-scope paths with the offending files named', () => {
    expect(() =>
      assertChangedFilesWithinScope(
        ['src/registry.ts', 'src/phenotype-store.ts', 'test/phenotype-store.test.ts'],
        scope,
        'before commit',
      ),
    ).toThrow(/Change scope violation \(before commit\).*src\/phenotype-store\.ts.*test\/phenotype-store\.test\.ts/s);
  });

  it('is inactive for tasks without a marker and fails closed on malformed markers', () => {
    const unscoped = scopedTask(['Shared TOKEN-CULLING constraint is an invariant.']);
    expect(enforceTaskChangeScope(unscoped, ['src/phenotype-store.ts'], 'before commit')).toBeUndefined();
    expect(enforceTaskChangeScope({ ...taskRecord(), spec: null }, ['anything.ts'], 'base-to-candidate')).toBeUndefined();
    const malformed = scopedTask(['Change scope: *']);
    expect(() => enforceTaskChangeScope(malformed, ['src/registry.ts'], 'before commit')).toThrow(
      'Malformed Change scope marker',
    );
  });

  it('rejects out-of-scope edits but allows in-scope edits for the same phase', () => {
    const task = scopedTask(['Change scope: src/registry.ts, test/', 'Shared TOKEN-CULLING constraint is an invariant.']);
    expect(() =>
      enforceTaskChangeScope(task, ['src/registry.ts', 'src/phenotype-store.ts'], 'task t before commit'),
    ).toThrow('Change scope violation');
    expect(
      enforceTaskChangeScope(task, ['src/registry.ts', 'test/registry.test.ts'], 'task t before commit'),
    ).toBeUndefined();
    expect(
      enforceTaskChangeScope(task, ['src/registry.ts', 'test/registry.test.ts'], 'task t base-to-candidate'),
    ).toBeUndefined();
  });
});

describe('change scope enforcement over real git worktrees', () => {
  it('covers additions, deletions, and both rename sides before commit', async () => {
    const { repo } = await createGitFixture();
    const git = new GitWorkspace(repo, makeTmp('change-scope-uncommitted'), defaultProjectConfig(repo, 'fixture', 'owner/fixture'));
    const task = scopedTask(['Change scope: registry.ts']);
    task.branch = branchFor(task);
    const worktree = await git.createOrResume({ ...task, branch: task.branch });
    writeFileSync(path.join(worktree.path, 'registry.ts'), 'export {};\n');
    renameSync(path.join(worktree.path, 'README.md'), path.join(worktree.path, 'RENAMED.md'));
    rmSync(path.join(worktree.path, 'AUTONOMY.md'));

    const changed = await git.changedFiles(worktree.path);
    // Uncommitted state: the added in-scope file is fine, but the rename and
    // deletion sides are out of scope and must be rejected together.
    expect(changed).toContain('registry.ts');
    expect(changed).toEqual(expect.arrayContaining(['README.md', 'RENAMED.md', 'AUTONOMY.md']));
    expect(() => enforceTaskChangeScope(task, changed, 'before commit')).toThrow(
      /AUTONOMY\.md.*README\.md.*RENAMED\.md/,
    );
    expect(enforceTaskChangeScope(task, ['registry.ts'], 'before commit')).toBeUndefined();
    await git.removeOwnedWorktree(worktree.path, { allowDirty: true });
  });

  it('allows in-scope changes and rejects out-of-scope rename sides and deletions base-to-candidate', async () => {
    const { repo } = await createGitFixture();
    const git = new GitWorkspace(repo, makeTmp('change-scope-committed'), defaultProjectConfig(repo, 'fixture', 'owner/fixture'));
    const task = scopedTask(['Change scope: skills/']);
    task.branch = branchFor(task);
    const worktree = await git.createOrResume({ ...task, branch: task.branch });
    task.baseSha = worktree.baseSha;
    const skillsDir = path.join(worktree.path, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(path.join(skillsDir, 'new.ts'), 'v1\n');
    // Rename a base-tracked file INTO scope: both sides must be enumerated,
    // and the out-of-scope source side must be rejected.
    renameSync(path.join(worktree.path, 'check.mjs'), path.join(skillsDir, 'runner.mjs'));
    rmSync(path.join(worktree.path, 'AUTONOMY.md'));
    await command(['add', '--all'], worktree.path);
    await command(['commit', '-m', 'in-scope add and rename, stray deletion'], worktree.path);
    const head = await command(['rev-parse', 'HEAD'], worktree.path);

    const changed = await git.filesChangedBetween(worktree.path, worktree.baseSha, head);
    // filesChangedBetween reports both rename sides and the deletion.
    expect(changed).toEqual(expect.arrayContaining(['skills/new.ts', 'check.mjs', 'skills/runner.mjs', 'AUTONOMY.md']));
    expect(() => enforceTaskChangeScope(task, changed, 'base-to-candidate')).toThrow(
      /AUTONOMY\.md.*check\.mjs/,
    );
    expect(
      enforceTaskChangeScope(task, changed.filter((file) => file !== 'check.mjs' && file !== 'AUTONOMY.md'), 'base-to-candidate'),
    ).toBeUndefined();
    await git.removeOwnedWorktree(worktree.path, { allowDirty: true });
  });
});

async function command(args: string[], cwd: string): Promise<string> {
  const result = await runProcess({ command: 'git', args, cwd, timeoutMs: 20_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
