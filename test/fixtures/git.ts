import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runProcess } from '../../src/runtime/safe-process.js';
import { makeTmp } from '../helpers.js';

export async function createGitFixture(): Promise<{ repo: string; remote: string }> {
  const root = makeTmp('git-fixture');
  const repo = path.join(root, 'repo');
  const remote = path.join(root, 'remote.git');
  mkdirSync(repo);
  mkdirSync(remote);
  await git(['init', '--bare'], remote);
  await git(['init', '-b', 'main'], repo);
  await git(['config', 'user.name', 'Fixture'], repo);
  await git(['config', 'user.email', 'fixture@example.com'], repo);
  writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  writeFileSync(path.join(repo, 'AUTONOMY.md'), '# protected contract\n');
  writeFileSync(
    path.join(repo, 'check.mjs'),
    "import { existsSync } from 'node:fs'; process.exit(existsSync('feature.txt') ? 0 : 1);\n",
  );
  await git(['add', '.'], repo);
  await git(['commit', '-m', 'initial'], repo);
  await git(['remote', 'add', 'origin', remote], repo);
  await git(['push', '-u', 'origin', 'main'], repo);
  return { repo, remote };
}

async function git(args: string[], cwd: string): Promise<string> {
  const result = await runProcess({ command: 'git', args, cwd, timeoutMs: 20_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
