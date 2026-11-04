import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  config: vi.fn(), authorize: vi.fn(), close: vi.fn(), find: vi.fn(), validateGitRm: vi.fn(), grant: vi.fn(), feedback: vi.fn(),
}));
vi.mock('../src/core/config.js', async (original) => ({
  ...await original<typeof import('../src/core/config.js')>(),
  loadProjectConfig: mock.config,
}));
vi.mock('../src/core/persistent-store.js', () => ({
  PersistentTaskStore: class {
    findByIssue = mock.find;
    authorizeRecovery = mock.authorize;
    grantGitRmPermission = mock.grant;
    recordOperatorFeedback = mock.feedback;
    retryBudget = () => ({ failures: 5, limit: 8 });
    close = mock.close;
  },
  validateAuthorizedGitRmPaths: mock.validateGitRm,
}));
import { main } from '../src/cli.js';

describe('operator recovery command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.config.mockReturnValue({ project: { name: 'test', root: '/tmp/test-project', githubRepo: 'owner/test' }, protectedPaths: ['AUTONOMY.md'] });
    mock.find.mockReturnValue({ id: 'task-35', worktreePath: '/tmp/worktree-35' });
    mock.authorize.mockReturnValue({ state: 'ready' });
    mock.validateGitRm.mockImplementation(async (_worktree: string, paths: string[]) => paths);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });
  const flags = ['--issue', '35', '--additional-attempts', '3', '--authorization', 'user-round-1',
    '--authorized-by', 'Fern', '--reason', 'Runtime repaired'];

  it('requires explicit operator confirmation before opening state', async () => {
    await expect(main(['recovery-authorize', ...flags])).rejects.toThrow('requires --yes');
    expect(mock.config).not.toHaveBeenCalled();
    expect(mock.authorize).not.toHaveBeenCalled();
  });

  it('binds authorization to the exact issue and parses root after named options', async () => {
    expect(await main(['recovery-authorize', ...flags, '/tmp/test-project', '--yes', '--json'])).toBe(0);
    expect(mock.config).toHaveBeenCalledWith('/tmp/test-project');
    expect(mock.find).toHaveBeenCalledWith(35);
    expect(mock.authorize).toHaveBeenCalledWith('task-35', {
      authorizationId: 'user-round-1', additionalAttempts: 3, authorizedBy: 'Fern', reason: 'Runtime repaired',
    });
    expect(mock.close).toHaveBeenCalledOnce();
  });

  it('does not authorize missing tasks and always closes the store', async () => {
    mock.find.mockReturnValue(undefined);
    await expect(main(['recovery-authorize', ...flags, '--yes'])).rejects.toThrow('No task exists');
    expect(mock.authorize).not.toHaveBeenCalled();
    expect(mock.close).toHaveBeenCalledOnce();
  });

  it.each(['--authorization', '--authorized-by', '--reason'])('rejects a missing %s value before opening state', async (option) => {
    const broken = [...flags];
    broken.splice(broken.indexOf(option) + 1, 1);
    await expect(main(['recovery-authorize', ...broken, '--yes'])).rejects.toThrow('requires --yes');
    expect(mock.config).not.toHaveBeenCalled();
    expect(mock.authorize).not.toHaveBeenCalled();
  });

  it('preserves a store rejection and closes the database', async () => {
    mock.authorize.mockImplementationOnce(() => { throw new Error('Recovery authorization conflicts'); });
    await expect(main(['recovery-authorize', ...flags, '--yes'])).rejects.toThrow('conflicts');
    expect(mock.close).toHaveBeenCalledOnce();
  });

  it('validates repeatable --allow-git-rm paths against the failed worktree and persists them', async () => {
    expect(await main(['recovery-authorize', ...flags, '--allow-git-rm', 'src/old.ts',
      '--allow-git-rm', 'src/stale.ts', '--yes'])).toBe(0);
    expect(mock.validateGitRm).toHaveBeenCalledWith('/tmp/worktree-35', ['src/old.ts', 'src/stale.ts'], ['AUTONOMY.md']);
    expect(mock.authorize).toHaveBeenCalledWith('task-35', {
      authorizationId: 'user-round-1', additionalAttempts: 3, authorizedBy: 'Fern', reason: 'Runtime repaired',
      allowGitRm: ['src/old.ts', 'src/stale.ts'],
    });
  });

  it('grants no removal permission without --allow-git-rm and rejects unsafe paths before authorizing', async () => {
    expect(await main(['recovery-authorize', ...flags, '--yes'])).toBe(0);
    expect(mock.validateGitRm).not.toHaveBeenCalled();
    expect(mock.authorize).toHaveBeenCalledWith('task-35', {
      authorizationId: 'user-round-1', additionalAttempts: 3, authorizedBy: 'Fern', reason: 'Runtime repaired',
    });
    mock.validateGitRm.mockRejectedValueOnce(new Error('Tracked-file removal path contains traversal: ../escape'));
    await expect(main(['recovery-authorize', ...flags, '--allow-git-rm', '../escape', '--yes'])).rejects.toThrow('traversal');
    expect(mock.authorize).toHaveBeenCalledTimes(1);
    expect(mock.close).toHaveBeenCalled();
  });
});

describe('operator tracked-file removal grant command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.config.mockReturnValue({ project: { name: 'test', root: '/tmp/test-project', githubRepo: 'owner/test' }, protectedPaths: ['AUTONOMY.md'] });
    mock.find.mockReturnValue({ id: 'task-35', state: 'ready', worktreePath: '/tmp/worktree-35' });
    mock.grant.mockReturnValue({ recoveryAuthorizationId: 'recovery-7', contractHash: 'abc123' });
    mock.validateGitRm.mockImplementation(async (_worktree: string, paths: string[]) => paths);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });
  const flags = ['--issue', '35', '--authorization', 'grant-round-1',
    '--authorized-by', 'Fern', '--reason', 'Runtime repaired', '--allow-git-rm', 'src/old.ts'];

  it('requires --yes and at least one --allow-git-rm path before opening state', async () => {
    await expect(main(['recovery-grant-git-rm', ...flags])).rejects.toThrow('requires --yes');
    await expect(main(['recovery-grant-git-rm', ...flags.slice(0, -2), '--yes'])).rejects.toThrow('requires --yes');
    expect(mock.config).not.toHaveBeenCalled();
    expect(mock.grant).not.toHaveBeenCalled();
  });

  it('validates paths against the ready worktree and grants without adding attempts', async () => {
    expect(await main(['recovery-grant-git-rm', ...flags, '--yes', '--json'])).toBe(0);
    expect(mock.validateGitRm).toHaveBeenCalledWith('/tmp/worktree-35', ['src/old.ts'], ['AUTONOMY.md']);
    expect(mock.grant).toHaveBeenCalledWith('task-35', {
      authorizationId: 'grant-round-1', authorizedBy: 'Fern', reason: 'Runtime repaired', allowGitRm: ['src/old.ts'],
    });
    expect(mock.authorize).not.toHaveBeenCalled();
    expect(mock.close).toHaveBeenCalledOnce();
  });

  it('rejects unsafe paths before any grant and preserves store rejections', async () => {
    mock.validateGitRm.mockRejectedValueOnce(new Error('Tracked-file removal path is not tracked in the task worktree: src/old.ts'));
    await expect(main(['recovery-grant-git-rm', ...flags, '--yes'])).rejects.toThrow('not tracked');
    expect(mock.grant).not.toHaveBeenCalled();
    mock.grant.mockImplementationOnce(() => { throw new Error('Tracked-file removal grant conflicts with its original binding'); });
    await expect(main(['recovery-grant-git-rm', ...flags, '--yes'])).rejects.toThrow('conflicts');
    expect(mock.close).toHaveBeenCalledTimes(2);
  });
});

describe('operator task-feedback command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.config.mockReturnValue({ project: { name: 'test', root: '/tmp/test-project', githubRepo: 'owner/test' } });
    mock.find.mockReturnValue({ id: 'task-35' });
    mock.feedback.mockReturnValue({ id: 'task-35', state: 'ready', attempts: 2, maxAttempts: 5, lastError: 'Operator feedback (rev-1): test deletes product database files' });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });
  const flags = ['--issue', '35', '--reason', 'Test deletes product database files', '--authorization', 'rev-1',
    '--authorized-by', 'Fern'];

  it('requires explicit operator confirmation before opening state', async () => {
    await expect(main(['task-feedback', ...flags])).rejects.toThrow('requires --yes');
    expect(mock.config).not.toHaveBeenCalled();
    expect(mock.feedback).not.toHaveBeenCalled();
  });

  it('binds feedback to the exact issue and authorization', async () => {
    expect(await main(['task-feedback', ...flags, '/tmp/test-project', '--yes', '--json'])).toBe(0);
    expect(mock.config).toHaveBeenCalledWith('/tmp/test-project');
    expect(mock.find).toHaveBeenCalledWith(35);
    expect(mock.feedback).toHaveBeenCalledWith('task-35', {
      authorizationId: 'rev-1', authorizedBy: 'Fern', reason: 'Test deletes product database files',
    });
    expect(mock.close).toHaveBeenCalledOnce();
  });

  it('does not record feedback for missing tasks and always closes the store', async () => {
    mock.find.mockReturnValue(undefined);
    await expect(main(['task-feedback', ...flags, '--yes'])).rejects.toThrow('No task exists');
    expect(mock.feedback).not.toHaveBeenCalled();
    expect(mock.close).toHaveBeenCalledOnce();
  });

  it.each(['--authorization', '--authorized-by', '--reason'])('rejects a missing %s value before opening state', async (option) => {
    const broken = [...flags];
    broken.splice(broken.indexOf(option) + 1, 1);
    await expect(main(['task-feedback', ...broken, '--yes'])).rejects.toThrow('requires --yes');
    expect(mock.config).not.toHaveBeenCalled();
    expect(mock.feedback).not.toHaveBeenCalled();
  });

  it('preserves a store rejection and closes the database', async () => {
    mock.feedback.mockImplementationOnce(() => { throw new Error('Operator feedback authorization conflicts'); });
    await expect(main(['task-feedback', ...flags, '--yes'])).rejects.toThrow('conflicts');
    expect(mock.close).toHaveBeenCalledOnce();
  });
});
