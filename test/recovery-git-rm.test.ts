import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GIT_RM_MAX_PATHS, PersistentTaskStore, validateAuthorizedGitRmPaths } from '../src/core/persistent-store.js';
import { gitRmCommandFor } from '../src/qwen/qwen-code-executor.js';
import type { TaskSpec } from '../src/core/types.js';
import { createGitFixture } from './fixtures/git.js';
import { makeTmp } from './helpers.js';

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
    expect(gitRmCommandFor(['src/old.ts'])).toBe('git rm -f -- src/old.ts');
    expect(gitRmCommandFor(['src/old.ts', 'src/deep/stale.ts'])).toBe('git rm -f -- src/old.ts src/deep/stale.ts');
    expect(() => gitRmCommandFor([])).toThrow(/at least one/);
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
