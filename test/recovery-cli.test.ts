import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  config: vi.fn(), authorize: vi.fn(), close: vi.fn(), find: vi.fn(),
}));
vi.mock('../src/core/config.js', async (original) => ({
  ...await original<typeof import('../src/core/config.js')>(),
  loadProjectConfig: mock.config,
}));
vi.mock('../src/core/persistent-store.js', () => ({
  PersistentTaskStore: class {
    findByIssue = mock.find;
    authorizeRecovery = mock.authorize;
    retryBudget = () => ({ failures: 5, limit: 8 });
    close = mock.close;
  },
}));
import { main } from '../src/cli.js';

describe('operator recovery command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.config.mockReturnValue({ project: { name: 'test', root: '/tmp/test-project', githubRepo: 'owner/test' } });
    mock.find.mockReturnValue({ id: 'task-35' });
    mock.authorize.mockReturnValue({ state: 'ready' });
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
});
