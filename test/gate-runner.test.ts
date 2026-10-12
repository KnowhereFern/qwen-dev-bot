import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskRecord } from '../src/core/types.js';
import { gateRunnerCommand, resolveInstalledGateRunner } from '../src/qwen/gate-runner.js';
import { goalPromptFor } from '../src/qwen/qwen-code-executor.js';

const fixtures: string[] = [];
function fixture(label = 'installed package') {
  const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'installed-gate-test-')));
  fixtures.push(temporary);
  const root = path.join(temporary, label);
  const runner = path.join(root, 'template/.qwen-harness/scripts/run-gates.mjs');
  mkdirSync(path.dirname(runner), { recursive: true });
  writeFileSync(runner, 'console.log(process.cwd());\n');
  return { root, runner, temporary };
}

afterEach(() => {
  for (const temporary of fixtures.splice(0)) rmSync(temporary, { recursive: true, force: true });
});

describe('installed gate runner compatibility', () => {
  it('resolves the bundled regular runner without consulting candidate project configuration', () => {
    const { root, runner } = fixture();
    writeFileSync(path.join(root, 'project-config.json'), JSON.stringify({ runner: '/untrusted/override.mjs' }));
    expect(resolveInstalledGateRunner(root)).toBe(realpathSync(runner));
    expect(resolveInstalledGateRunner()).toBe(realpathSync(path.resolve(import.meta.dirname, '../template/.qwen-harness/scripts/run-gates.mjs')));
  });

  it.each(['missing', 'directory'])('refuses a %s runner', kind => {
    const { root, runner } = fixture();
    rmSync(runner);
    if (kind === 'directory') mkdirSync(runner);
    expect(() => resolveInstalledGateRunner(root)).toThrow('installed harness gate runner is missing or unsafe');
  });

  it.each(['inside', 'outside'])('refuses a symlink runner pointing %s the package', location => {
    const { root, runner, temporary } = fixture();
    const target = path.join(location === 'inside' ? root : temporary, 'other-runner.mjs');
    writeFileSync(target, 'console.log("must not execute");');
    rmSync(runner);
    symlinkSync(target, runner, 'file');
    expect(() => resolveInstalledGateRunner(root)).toThrow('installed harness gate runner is missing or unsafe');
  });

  it('refuses a symlink parent even when it points inside the package', () => {
    const { root, runner } = fixture();
    const target = path.join(root, 'actual-scripts');
    mkdirSync(target);
    writeFileSync(path.join(target, 'run-gates.mjs'), 'console.log("must not execute");');
    rmSync(path.dirname(runner), { recursive: true });
    symlinkSync(target, path.dirname(runner), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => resolveInstalledGateRunner(root)).toThrow('installed harness gate runner is missing or unsafe');
  });

  it.skipIf(process.platform === 'win32')('executes the exact runner from candidate cwd despite spaces, apostrophes, and shell metacharacters', () => {
    const { root, runner, temporary } = fixture("package ' ; $(touch SHOULD_NOT_EXIST) `touch ALSO_NOT_CREATED` & $name");
    const candidate = path.join(temporary, 'candidate worktree');
    mkdirSync(candidate);
    const command = gateRunnerCommand(resolveInstalledGateRunner(root));
    const result = spawnSync('/bin/sh', ['-c', command], { cwd: candidate, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(candidate);
    expect(readFileSync(runner, 'utf8')).toBe('console.log(process.cwd());\n');
    expect(existsSync(path.join(candidate, 'SHOULD_NOT_EXIST'))).toBe(false);
    expect(existsSync(path.join(candidate, 'ALSO_NOT_CREATED'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('quotes both executable and runner as separate literal POSIX arguments', () => {
    const executable = "/runtime 'node'; $(printf bad) `printf bad` & x";
    const runner = "/package 'runner' $(printf bad)/run-gates.mjs";
    const result = spawnSync('/bin/sh', ['-c', `printf '%s\\0' ${gateRunnerCommand(runner, executable, 'linux')}`], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.split('\0')).toEqual([executable, runner, '']);
  });

  it('encodes literal Windows paths so cmd, PowerShell, and Git Bash cannot interpret their contents', () => {
    const command = gateRunnerCommand("C:\\Package's $name; $(whoami)\\run-gates.mjs", "C:\\Node's home\\node.exe", 'win32');
    expect(command).toMatch(/^powershell\.exe -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
    expect(Buffer.from(command.split(' ').at(-1)!, 'base64').toString('utf16le'))
      .toBe("& 'C:\\Node''s home\\node.exe' 'C:\\Package''s $name; $(whoami)\\run-gates.mjs'; exit $LASTEXITCODE");
  });

  it.skipIf(process.platform !== 'win32')('executes the exact Windows runner through cmd from candidate cwd and preserves its exit code', () => {
    const { root, runner, temporary } = fixture("Package's $name; $(Write-Output injected) & runtime");
    const candidate = path.join(temporary, 'candidate worktree');
    mkdirSync(candidate);
    const command = gateRunnerCommand(resolveInstalledGateRunner(root));
    const result = spawnSync('cmd.exe', ['/d', '/s', '/c', command], { cwd: candidate, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(candidate);
    writeFileSync(runner, 'process.exit(7);');
    expect(spawnSync('cmd.exe', ['/d', '/s', '/c', command], { cwd: candidate, encoding: 'utf8' }).status).toBe(7);
  });

  it.each(['', '/runner\ncommand', '/runner\rcommand', '/runner\0command'])('refuses unsafe command framing %j', runner => {
    expect(() => gateRunnerCommand(runner)).toThrow('installed harness gate runner is missing or unsafe');
  });

  it('hands the installed command to an old saved workflow without granting coordinator execution', () => {
    const task = { id: 'task', issueNumber: 124, title: 'Preserve candidate', body: 'Existing product contract', spec: null,
      qwenSessionId: null, qwenWorkflowRunId: null } as TaskRecord;
    const prompt = goalPromptFor(task, [], '/candidate/.qwen/workflows/harness-implement.js');
    expect(prompt).toContain(JSON.stringify(gateRunnerCommand(resolveInstalledGateRunner())));
    expect(prompt).toContain('localGateCommand and its verification instructions in the saved workflow args');
    expect(prompt).toContain('sole saved-workflow implementer must execute it');
    expect(prompt).toContain('from the current candidate worktree after its final edits');
    expect(prompt).toContain('older saved workflow or project gate script');
    expect(prompt).toContain('do not copy it into the repository, edit it, or update tracked harness files');
    expect(prompt).toContain('never call run_shell_command');
    expect(prompt).toContain('supervisor\'s independent exact-commit verification');
    expect(prompt).not.toContain('implementer running node .qwen-harness/scripts/run-gates.mjs');
  });
});
