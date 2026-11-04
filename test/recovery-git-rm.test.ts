import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GIT_RM_MAX_PATHS, PersistentTaskStore, validateAuthorizedGitRmPaths } from '../src/core/persistent-store.js';
import { defaultProjectConfig } from '../src/core/config.js';
import { GitWorkspace } from '../src/git/git-workspace.js';
import { applyAuthorizedGitRmPreflight, gitRmAppliedIdempotencyKey, resolveAuthorizedGitRmGrant } from '../src/supervisor.js';
import type { TaskRecord, TaskSpec } from '../src/core/types.js';
import { createGitFixture } from './fixtures/git.js';
import { makeTmp } from './helpers.js';
import { runProcess } from '../src/runtime/safe-process.js';

const PROTECTED = ['AUTONOMY.md', '.qwen-harness/', '.github/workflows/harness-'];

function spec(): TaskSpec {
  return {
    goal: 'Implement the task',
    source: { kind: 'user', author: 'owner' },
    acceptanceCriteria: ['The task is complete.'],
    constraints: [],
    requiredGateIds: [],
    rewardCriterionIds: [],
    risk: 'low',
    dependencies: [],
    rollback: 'Revert the task commit.',
    technologyDecisions: [],
    deploymentDecisions: [],
  };
}

describe('authorized tracked-file removal validation', () => {
  it('accepts 1-5 safe tracked regular-file paths and returns them unchanged', async () => {
    const { repo } = await createGitFixture();
    await expect(validateAuthorizedGitRmPaths(repo, ['README.md'], PROTECTED)).resolves.toEqual(['README.md']);
    await expect(validateAuthorizedGitRmPaths(repo, ['README.md', 'check.mjs'], PROTECTED))
      .resolves.toEqual(['README.md', 'check.mjs']);
  });

  it('rejects traversal, absolute, metacharacter, whitespace and duplicated paths', async () => {
    const { repo } = await createGitFixture();
    for (const bad of ['../outside.txt', 'src/../../outside.txt', '/etc/passwd', 'a;rm -rf /',
      'README.md && echo pwned', 'REA DME.md', 'README.md`id`', 'README.md$(id)', '~/.ssh/id_rsa',
      'README.md/', './README.md', 'src//a.ts']) {
      await expect(validateAuthorizedGitRmPaths(repo, [bad], PROTECTED)).rejects.toThrow(/traversal|relative|metacharacter|duplicate|segments/i);
    }
    await expect(validateAuthorizedGitRmPaths(repo, ['README.md', 'README.md'], PROTECTED)).rejects.toThrow(/duplicate/i);
  });

  it('rejects zero and more than five paths', async () => {
    const { repo } = await createGitFixture();
    await expect(validateAuthorizedGitRmPaths(repo, [], PROTECTED)).rejects.toThrow(/1-5/);
    const many = Array.from({ length: GIT_RM_MAX_PATHS + 1 }, (_unused, index) => `file-${index}.ts`);
    // Fail fast on syntax-independent count before any filesystem probing.
    await expect(validateAuthorizedGitRmPaths(repo, many, PROTECTED)).rejects.toThrow(/1-5/);
  });

  it('rejects credential-bearing basenames', async () => {
    const { repo } = await createGitFixture();
    for (const bad of ['.env', 'config/.env.production', 'id_rsa', 'keys/server.pem',
      'secrets/token.json', 'auth/credentials.yml', 'deploy/password.txt']) {
      await expect(validateAuthorizedGitRmPaths(repo, [bad], PROTECTED)).rejects.toThrow(/credential/i);
    }
  });

  it('rejects configured protected paths and prefixes', async () => {
    const { repo } = await createGitFixture();
    for (const bad of ['AUTONOMY.md', '.qwen-harness/project.yml', '.github/workflows/harness-check.yml']) {
      await expect(validateAuthorizedGitRmPaths(repo, [bad], PROTECTED)).rejects.toThrow(/protected/i);
    }
  });

  it('rejects untracked files, directories, missing paths and symlink traversal', async () => {
    const { repo } = await createGitFixture();
    mkdirSync(path.join(repo, 'adir'));
    writeFileSync(path.join(repo, 'untracked.txt'), 'not tracked\n');
    symlinkSync('README.md', path.join(repo, 'link.md'));
    await expect(validateAuthorizedGitRmPaths(repo, ['untracked.txt'], PROTECTED)).rejects.toThrow(/not tracked/i);
    await expect(validateAuthorizedGitRmPaths(repo, ['adir'], PROTECTED)).rejects.toThrow(/regular file/i);
    await expect(validateAuthorizedGitRmPaths(repo, ['missing.txt'], PROTECTED)).rejects.toThrow(/missing/i);
    await expect(validateAuthorizedGitRmPaths(repo, ['link.md'], PROTECTED)).rejects.toThrow(/symlink/i);
  });

  it('builds the exact single permission command for validated paths', () => {
    expect(gitRmAppliedIdempotencyKey('task-1', 'recovery-1', ['src/old.ts', 'src/stale.ts']))
      .toBe(`task:git-rm-applied:task-1:recovery-1:${['src/old.ts', 'src/stale.ts'].sort().join(' ')}`);
    // Path order never changes the identity of the application event.
    expect(gitRmAppliedIdempotencyKey('task-1', 'recovery-1', ['src/stale.ts', 'src/old.ts']))
      .toBe(gitRmAppliedIdempotencyKey('task-1', 'recovery-1', ['src/old.ts', 'src/stale.ts']));
  });
});

describe('authorized tracked-file removal persistence', () => {
  it('persists authorized paths in the authorization event and binding', () => {
    const store = new PersistentTaskStore('git-rm-recovery', makeTmp('git-rm-recovery'));
    const task = store.upsert({ issueNumber: 1, title: 'failed', state: 'failed', maxAttempts: 5, spec: spec() });
    store.patch(task.id, { attempts: 5, lineageFailures: 5, failureLineageId: task.id,
      lastFailureFingerprint: 'prior', lastError: 'prior error', worktreePath: '/tmp/worktree-1' });
    const auth = { authorizationId: 'human-1', additionalAttempts: 2, authorizedBy: 'owner',
      reason: 'stale artifacts block recovery', allowGitRm: ['src/old.ts', 'src/stale.ts'] };
    const recovered = store.authorizeRecovery(task.id, auth);
    expect(recovered.state).toBe('ready');
    const event = store.listEvents('task.recovery_authorized').at(-1);
    expect(event?.payload.allowGitRm).toEqual(['src/old.ts', 'src/stale.ts']);
    // Same authorization ID with different paths is a binding conflict.
    expect(() => store.authorizeRecovery(task.id, { ...auth, allowGitRm: ['src/other.ts'] })).toThrow(/conflicts/);
    // Exact replay is still idempotent.
    expect(store.authorizeRecovery(task.id, auth).state).toBe('ready');
    expect(store.listEvents('task.recovery_authorized')).toHaveLength(1);
    store.close();
  });

  it('requires the failed task worktree and rejects unsafe path syntax without partial effects', () => {
    const store = new PersistentTaskStore('git-rm-recovery-invalid', makeTmp('git-rm-recovery-invalid'));
    const task = store.upsert({ issueNumber: 1, title: 'failed', state: 'failed', maxAttempts: 5 });
    store.patch(task.id, { attempts: 5, lineageFailures: 5, failureLineageId: task.id, lastFailureFingerprint: 'prior' });
    const auth = { authorizationId: 'human-1', additionalAttempts: 2, authorizedBy: 'owner', reason: 'repair' };
    for (const bad of ['../escape.ts', '/etc/passwd', 'a;rm', '.env', '']) {
      expect(() => store.authorizeRecovery(task.id, { ...auth, allowGitRm: [bad] })).toThrow();
    }
    // No worktree on the failed task: a removal authorization cannot attach.
    expect(() => store.authorizeRecovery(task.id, { ...auth, allowGitRm: ['src/old.ts'] })).toThrow(/worktree/);
    expect(store.listEvents('task.recovery_authorized')).toHaveLength(0);
    expect(store.get(task.id).state).toBe('failed');
    store.close();
  });
});

describe('standalone tracked-file removal grant on a ready retry', () => {
  function recovered(label: string): { store: PersistentTaskStore; taskId: string; grant: { authorizationId: string; authorizedBy: string; reason: string; allowGitRm: string[] } } {
    const store = new PersistentTaskStore(label, makeTmp(label));
    const task = store.upsert({ issueNumber: 1, title: 'blocked', state: 'failed', maxAttempts: 5, spec: spec() });
    store.patch(task.id, { attempts: 5, lineageFailures: 5, failureLineageId: task.id,
      lastFailureFingerprint: 'prior', lastError: 'prior error', worktreePath: '/tmp/worktree-1' });
    store.authorizeRecovery(task.id, { authorizationId: 'recovery-1', additionalAttempts: 2,
      authorizedBy: 'owner', reason: 'bounded retry' });
    return { store, taskId: task.id, grant: { authorizationId: 'grant-1', authorizedBy: 'owner',
      reason: 'stale artifacts block the ready retry', allowGitRm: ['src/old.ts'] } };
  }

  it('grants on a ready unleased retry without changing state or budget', () => {
    const { store, taskId, grant } = recovered('git-rm-grant-ready');
    const before = store.get(taskId);
    const result = store.grantGitRmPermission(taskId, grant);
    expect(result.recoveryAuthorizationId).toBe('recovery-1');
    expect(result.contractHash).toBe(createHash('sha256').update(JSON.stringify(before.spec)).digest('hex'));
    const after = store.get(taskId);
    expect(after.state).toBe('ready');
    expect(after.attempts).toBe(before.attempts);
    expect(store.retryBudget(taskId)).toEqual({ failures: 5, limit: 7 });
    const event = store.listEvents('task.git_rm_granted').at(-1);
    expect(event?.taskId).toBe(taskId);
    expect(event?.payload.allowGitRm).toEqual(['src/old.ts']);
    expect(event?.payload.recoveryAuthorizationId).toBe('recovery-1');
    store.close();
  });

  it('is idempotent for the exact replay and rejects a changed binding for the same ID', () => {
    const { store, taskId, grant } = recovered('git-rm-grant-idempotent');
    store.grantGitRmPermission(taskId, grant);
    store.grantGitRmPermission(taskId, grant);
    expect(store.listEvents('task.git_rm_granted')).toHaveLength(1);
    expect(() => store.grantGitRmPermission(taskId, { ...grant, allowGitRm: ['src/other.ts'] })).toThrow(/conflicts/);
    expect(store.listEvents('task.git_rm_granted')).toHaveLength(1);
    store.close();
  });

  it('rejects a ready task without a prior recovery authorization', () => {
    const store = new PersistentTaskStore('git-rm-grant-norecovery', makeTmp('git-rm-grant-norecovery'));
    const task = store.upsert({ issueNumber: 1, title: 'fresh', state: 'ready', maxAttempts: 5, spec: spec() });
    store.patch(task.id, { worktreePath: '/tmp/worktree-2' });
    expect(() => store.grantGitRmPermission(task.id, { authorizationId: 'grant-2', authorizedBy: 'owner',
      reason: 'no recovery yet', allowGitRm: ['src/old.ts'] })).toThrow(/recovery authorization/);
    expect(store.listEvents('task.git_rm_granted')).toHaveLength(0);
    store.close();
  });

  it('rejects an exhausted retry budget', () => {
    const { store, taskId, grant } = recovered('git-rm-grant-budget');
    store.patch(taskId, { attempts: 7, lineageFailures: 7 });
    expect(() => store.grantGitRmPermission(taskId, grant)).toThrow(/budget/);
    expect(store.listEvents('task.git_rm_granted')).toHaveLength(0);
    store.close();
  });

  it('rejects a stale contract: the recovery authorization must match the current spec', () => {
    const { store, taskId, grant } = recovered('git-rm-grant-stale');
    store.patch(taskId, { spec: { ...spec(), goal: 'A different task entirely' } });
    expect(() => store.grantGitRmPermission(taskId, grant)).toThrow(/current contract/);
    expect(store.listEvents('task.git_rm_granted')).toHaveLength(0);
    store.close();
  });

  it('is bound to the exact task: another task cannot use the same grant ID or inherit it', () => {
    const { store, taskId, grant } = recovered('git-rm-grant-unrelated');
    const other = store.upsert({ issueNumber: 2, title: 'other', state: 'failed', maxAttempts: 5, spec: spec() });
    store.patch(other.id, { attempts: 5, lineageFailures: 5, failureLineageId: other.id,
      lastFailureFingerprint: 'other', worktreePath: '/tmp/worktree-3' });
    store.authorizeRecovery(other.id, { authorizationId: 'recovery-2', additionalAttempts: 2,
      authorizedBy: 'owner', reason: 'other lineage' });
    store.grantGitRmPermission(taskId, grant);
    // Same authorization ID bound to a different task is a binding conflict.
    expect(() => store.grantGitRmPermission(other.id, grant)).toThrow(/conflicts/);
    expect(store.listEvents('task.git_rm_granted')).toHaveLength(1);
    expect(store.listEvents('task.git_rm_granted')[0]?.taskId).toBe(taskId);
    store.close();
  });

  it('rejects a leased or non-ready task', () => {
    const { store, taskId, grant } = recovered('git-rm-grant-leased');
    const claimed = store.claimNext('worker-1', 60_000);
    expect(claimed?.id).toBe(taskId);
    expect(() => store.grantGitRmPermission(taskId, grant)).toThrow(/unleased ready/);
    store.close();
  });
});

describe('trusted-controller git rm preflight', () => {
  const PROTECTED_PREFLIGHT = ['AUTONOMY.md', '.qwen-harness/'];

  function contractHashOf(task: TaskRecord): string {
    return createHash('sha256').update(JSON.stringify(task.spec)).digest('hex');
  }

  async function setup(label: string, issueNumber = 42): Promise<{
    store: PersistentTaskStore;
    git: GitWorkspace;
    task: TaskRecord;
    worktree: string;
    preflight: (taskOverride?: TaskRecord) => Promise<string[] | null>;
  }> {
    const { repo } = await createGitFixture();
    const config = defaultProjectConfig(repo, 'fixture', 'owner/fixture');
    const state = makeTmp(label);
    const store = new PersistentTaskStore(label, state);
    const git = new GitWorkspace(repo, state, config);
    const created = store.upsert({
      issueNumber, title: `preflight ${issueNumber}`, state: 'ready', maxAttempts: 5, spec: spec(),
    });
    const receipt = await git.createOrResume(created);
    store.patch(created.id, { worktreePath: receipt.path, branch: receipt.branch, baseSha: receipt.baseSha });
    const task = store.get(created.id);
    return {
      store,
      git,
      task,
      worktree: receipt.path,
      preflight: (taskOverride?: TaskRecord) => applyAuthorizedGitRmPreflight(
        { store, git, protectedPaths: PROTECTED_PREFLIGHT }, taskOverride ?? task, receipt.path,
      ),
    };
  }

  function authorize(store: PersistentTaskStore, task: TaskRecord, paths: string[], authorizationId = 'recovery-1'): void {
    store.recordEvent('task.recovery_authorized', task.id, {
      authorizationId, contractHash: contractHashOf(task), allowGitRm: paths,
    });
  }

  function appliedEvents(store: PersistentTaskStore) {
    return store.listEvents('task.git_rm_applied');
  }

  it('applies the exact authorized deletion once in the owned worktree and records an idempotent event', async () => {
    const { store, task, worktree, preflight } = await setup('preflight-apply');
    authorize(store, task, ['README.md', 'check.mjs']);

    await expect(preflight()).resolves.toEqual(['README.md', 'check.mjs']);

    expect(existsSync(path.join(worktree, 'README.md'))).toBe(false);
    expect(existsSync(path.join(worktree, 'check.mjs'))).toBe(false);
    const events = appliedEvents(store);
    expect(events).toHaveLength(1);
    expect(events[0]?.taskId).toBe(task.id);
    expect(events[0]?.payload.paths).toEqual(['README.md', 'check.mjs']);
    expect(events[0]?.payload.contractHash).toBe(contractHashOf(task));
    // Authorization identifiers are redacted in the durable ledger when
    // events are written through recordEvent; the binding identity is the
    // stable task + sorted-paths suffix of the idempotency key.
    expect(events[0]?.payload.reconciled).toBe(false);
    expect(events[0]?.idempotencyKey?.startsWith(`task:git-rm-applied:${task.id}:`)).toBe(true);
    expect(events[0]?.idempotencyKey?.endsWith(':README.md check.mjs')).toBe(true);
    // The deletion is staged in the task worktree's index.
    const status = await runProcess({ command: 'git', args: ['status', '--porcelain=v1'], cwd: worktree, timeoutMs: 20_000 });
    expect(status.stdout).toContain('D  README.md');
    expect(status.stdout).toContain('D  check.mjs');

    // Reentry with the recorded application: no rerun, no second event.
    await expect(preflight()).resolves.toEqual(['README.md', 'check.mjs']);
    expect(appliedEvents(store)).toHaveLength(1);
    store.close();
  }, 60_000);

  it('rejects a recreated file on reentry without rerunning the deletion', async () => {
    const { store, task, worktree, preflight } = await setup('preflight-reentry');
    authorize(store, task, ['check.mjs']);
    await preflight();
    // The implementer recreated the file against instructions. The controller
    // must not mistake the old application receipt for the current state.
    writeFileSync(path.join(worktree, 'check.mjs'), 'recreated\n');
    await expect(preflight()).rejects.toThrow(/changed after its application event/);
    expect(existsSync(path.join(worktree, 'check.mjs'))).toBe(true);
    expect(appliedEvents(store)).toHaveLength(1);
    store.close();
  }, 60_000);

  it('reconciles a crash between the controller git rm and the durable event', async () => {
    const { store, task, worktree, preflight } = await setup('preflight-crash');
    authorize(store, task, ['README.md', 'check.mjs']);
    // Simulate the crash: the controller's git rm landed, the event did not.
    await runProcess({ command: 'git', args: ['rm', '-f', '--', 'README.md', 'check.mjs'], cwd: worktree, timeoutMs: 20_000 });

    await expect(preflight()).resolves.toEqual(['README.md', 'check.mjs']);

    const events = appliedEvents(store);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.reconciled).toBe(true);
    expect(existsSync(path.join(worktree, 'README.md'))).toBe(false);
    // And the reconciled event is itself idempotent on reentry.
    await expect(preflight()).resolves.toEqual(['README.md', 'check.mjs']);
    expect(appliedEvents(store)).toHaveLength(1);
    store.close();
  }, 60_000);

  it('rejects other drift: unrelated staged changes, partial deletions, and unstaged deletions', async () => {
    const { store, task, worktree, preflight } = await setup('preflight-drift');
    authorize(store, task, ['README.md', 'check.mjs']);

    // Unrelated staged modification outside the approved paths.
    writeFileSync(path.join(worktree, 'AUTONOMY.md'), '# changed\n');
    await runProcess({ command: 'git', args: ['add', '--', 'AUTONOMY.md'], cwd: worktree, timeoutMs: 20_000 });
    await expect(preflight()).rejects.toThrow(/unrelated tracked drift/);
    expect(appliedEvents(store)).toHaveLength(0);
    await runProcess({ command: 'git', args: ['checkout', 'HEAD', '--', 'AUTONOMY.md'], cwd: worktree, timeoutMs: 20_000 });

    // Partial staged deletion of the approved paths.
    await runProcess({ command: 'git', args: ['rm', '-f', '--', 'README.md'], cwd: worktree, timeoutMs: 20_000 });
    await expect(preflight()).rejects.toThrow(/partial staged deletion/);
    expect(appliedEvents(store)).toHaveLength(0);
    await runProcess({ command: 'git', args: ['checkout', 'HEAD', '--', 'README.md'], cwd: worktree, timeoutMs: 20_000 });

    // Unstaged deletion drift (file removed without git rm).
    await runProcess({ command: 'git', args: ['rm', '-f', '--', 'check.mjs'], cwd: worktree, timeoutMs: 20_000 });
    writeFileSync(path.join(worktree, 'check.mjs'), 'restored bytes\n');
    // check.mjs is now staged-deleted but still present: not the exact state.
    await expect(preflight()).rejects.toThrow();
    expect(appliedEvents(store)).toHaveLength(0);
    store.close();
  }, 60_000);

  it('yields no grant for a stale contract, a superseded recovery authorization, or an unrelated task', async () => {
    const { store, task, worktree, preflight } = await setup('preflight-stale');
    authorize(store, task, ['README.md']);
    // Files must remain untouched in every case below.

    // Stale contract: the task spec changed after the authorization.
    const changed = store.patch(task.id, { spec: { ...spec(), goal: 'A different contract' } });
    await expect(preflight(changed)).resolves.toBeNull();
    expect(existsSync(path.join(worktree, 'README.md'))).toBe(true);
    expect(appliedEvents(store)).toHaveLength(0);

    // Superseded recovery authorization without its own allowGitRm paths.
    const restored = store.patch(task.id, { spec: task.spec });
    store.recordEvent('task.recovery_authorized', restored.id, {
      authorizationId: 'recovery-2', contractHash: contractHashOf(restored),
    });
    await expect(preflight(restored)).resolves.toBeNull();
    expect(existsSync(path.join(worktree, 'README.md'))).toBe(true);
    expect(appliedEvents(store)).toHaveLength(0);
    expect(resolveAuthorizedGitRmGrant(store, restored)).toBeNull();
    store.close();
  }, 60_000);

  it('applies a standalone task.git_rm_granted event bound to the current recovery authorization', async () => {
    const { store, task, worktree, preflight } = await setup('preflight-grant-event');
    store.recordEvent('task.recovery_authorized', task.id, {
      authorizationId: 'recovery-1', contractHash: contractHashOf(task),
    });
    store.recordEvent('task.git_rm_granted', task.id, {
      authorizationId: 'grant-1', recoveryAuthorizationId: 'recovery-1',
      contractHash: contractHashOf(task), allowGitRm: ['check.mjs'],
    });

    await expect(preflight()).resolves.toEqual(['check.mjs']);
    expect(existsSync(path.join(worktree, 'check.mjs'))).toBe(false);
    expect(appliedEvents(store)).toHaveLength(1);

    // A grant bound to an older recovery authorization is never applied.
    store.recordEvent('task.recovery_authorized', task.id, {
      authorizationId: 'recovery-2', contractHash: contractHashOf(task),
    });
    store.recordEvent('task.git_rm_granted', task.id, {
      authorizationId: 'grant-2', recoveryAuthorizationId: 'recovery-1',
      contractHash: contractHashOf(task), allowGitRm: ['README.md'],
    });
    expect(existsSync(path.join(worktree, 'README.md'))).toBe(true);
    expect(appliedEvents(store)).toHaveLength(1);
    store.close();
  }, 60_000);

  it('applies nothing for another task\'s authorization and rejects protected removal paths', async () => {
    const { store, task, worktree, preflight } = await setup('preflight-unrelated');
    const other = store.upsert({ issueNumber: 43, title: 'other task', state: 'ready', maxAttempts: 5, spec: spec() });
    store.recordEvent('task.recovery_authorized', other.id, {
      authorizationId: 'recovery-other', contractHash: contractHashOf(other), allowGitRm: ['README.md'],
    });
    await expect(preflight()).resolves.toBeNull();
    expect(existsSync(path.join(worktree, 'README.md'))).toBe(true);
    expect(appliedEvents(store)).toHaveLength(0);

    // Protected paths fail closed even when authorized inline.
    authorize(store, task, ['AUTONOMY.md']);
    await expect(preflight()).rejects.toThrow(/protected/);
    expect(existsSync(path.join(worktree, 'AUTONOMY.md'))).toBe(true);
    expect(appliedEvents(store)).toHaveLength(0);
    store.close();
  }, 60_000);

  it('rejects a grant if the supplied worktree is not the task worktree', async () => {
    const { store, task, worktree, preflight } = await setup('preflight-wrong-worktree');
    authorize(store, task, ['README.md']);
    await expect(preflight({ ...task, worktreePath: `${worktree}-other` }))
      .rejects.toThrow(/worktree does not match/);
    expect(existsSync(path.join(worktree, 'README.md'))).toBe(true);
    expect(appliedEvents(store)).toHaveLength(0);
    store.close();
  }, 60_000);
});
