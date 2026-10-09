import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const runner = path.resolve(import.meta.dirname, '../template/.qwen-harness/scripts/run-gates.mjs');
const fixtures: string[] = [];
const secret = 'receipt-must-not-capture-this-output';

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'gate-receipt-test-')));
  fixtures.push(root);
  mkdirSync(path.join(root, '.qwen-harness'));
  writeFileSync(path.join(root, '.gitignore'), '.qwen-harness/state/\nignored-output.txt\n');
  writeFileSync(path.join(root, 'source.txt'), 'candidate\n');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['add', '.gitignore', 'source.txt'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Gate Test', '-c', 'user.email=gate@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
  return root;
}

function gate(id: string, script = 'process.exit(0)', extra: Record<string, unknown> = {}) {
  return { id, command: process.execPath, args: ['-e', script], required: true, timeoutMs: 5_000, ...extra };
}

function config(root: string, gates: ReturnType<typeof gate>[]) {
  writeFileSync(path.join(root, '.qwen-harness/project.yml'), JSON.stringify({ gates }));
}

function execute(root: string) {
  return spawnSync(process.execPath, [runner], { cwd: root, encoding: 'utf8', timeout: 15_000 });
}

function readReceipt(root: string) {
  return JSON.parse(readFileSync(path.join(root, '.qwen-harness/state/gate-receipt.json'), 'utf8'));
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('deterministic gate execution receipts', () => {
  it('records actual executions, applicable gates, hashes, and private permissions without capturing output', () => {
    const root = fixture();
    // The emitted secret is absent from argv as well as the receipt.
    writeFileSync(path.join(root, 'check.cjs'), `console.log(${JSON.stringify(secret)});`);
    config(root, [gate('unit', '', { args: ['check.cjs'] }), gate('optional', '', { required: false, notApplicableReason: 'No browser app' })]);
    const result = execute(root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(secret);
    expect(result.stdout).toContain('PASS unit');
    expect(result.stdout).toContain('N/A  optional');
    const receipt = readReceipt(root);
    expect(receipt).toMatchObject({ version: 1, cwd: root, worktree: root, status: 'passed' });
    expect(receipt.runId).toMatch(/^[a-f0-9-]{36}$/);
    expect(receipt.head).toMatch(/^[a-f0-9]{40,64}$/);
    expect(receipt.configHash).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.contentHash).toBe(receipt.finalContentHash);
    expect(receipt.gates[0]).toMatchObject({ id: 'unit', command: process.execPath, args: ['check.cjs'], cwd: root, required: true, applicable: true, status: 'passed', exitCode: 0, signal: null, timedOut: false });
    expect(receipt.gates[1]).toMatchObject({ status: 'not_applicable', applicable: false, exitCode: null });
    expect(Date.parse(receipt.finishedAt)).toBeGreaterThanOrEqual(Date.parse(receipt.startedAt));
    expect(JSON.stringify(receipt)).not.toContain(secret);
    expect(readFileSync(path.join(root, '.qwen-harness/state/gate-receipt.json'), 'utf8')).toContain('\n  "gates": [\n');
    expect(statSync(path.join(root, '.qwen-harness/state/gate-receipt.json')).mode & 0o777).toBe(0o600);
  });

  it('replaces a stale passing receipt and stops after a failed required gate', () => {
    const root = fixture();
    config(root, [gate('unit')]);
    expect(execute(root).status).toBe(0);
    const prior = readReceipt(root);
    config(root, [gate('unit', 'process.exit(7)', { notApplicableReason: 'Must not skip required gates' }), gate('later')]);
    expect(execute(root).status).toBe(7);
    const receipt = readReceipt(root);
    expect(receipt.runId).not.toBe(prior.runId);
    expect(receipt.status).toBe('failed');
    expect(receipt.gates[0]).toMatchObject({ status: 'failed', applicable: true, exitCode: 7 });
    expect(receipt.gates[1]).toMatchObject({ status: 'pending', exitCode: null });
  });

  it('writes pending before execution so an interrupted run cannot retain a prior pass', () => {
    const root = fixture();
    config(root, [gate('unit')]);
    expect(execute(root).status).toBe(0);
    const prior = readReceipt(root);
    config(root, [gate('pending-proof', "const r=JSON.parse(require('fs').readFileSync('.qwen-harness/state/gate-receipt.json')); console.log(r.status); process.exit(r.status==='pending'?0:9)")]);
    const result = execute(root);
    expect(result.stdout).toContain('\npending\n');
    expect(result.status).toBe(0);
    expect(readReceipt(root).runId).not.toBe(prior.runId);
  });

  it('records a missing executable as failure without persisting exception output', () => {
    const root = fixture();
    config(root, [gate('missing', '', { command: path.join(root, 'missing-executable'), args: [] })]);
    expect(execute(root).status).not.toBe(0);
    expect(readReceipt(root)).toMatchObject({ status: 'failed', gates: [{ status: 'failed', errorCode: 'ENOENT' }] });
  });

  it('fails a timed-out gate even when its SIGTERM handler exits zero', () => {
    const root = fixture();
    config(root, [gate('timeout', "process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},100)", { timeoutMs: 500 })]);
    expect(execute(root).status).toBe(124);
    expect(readReceipt(root)).toMatchObject({ status: 'failed', gates: [{ status: 'failed', exitCode: 0, timedOut: true }] });
  });

  it('invalidates stale success even when config becomes unreadable', () => {
    const root = fixture();
    config(root, [gate('unit')]);
    expect(execute(root).status).toBe(0);
    writeFileSync(path.join(root, '.qwen-harness/project.yml'), '{invalid');
    expect(execute(root).status).toBe(1);
    expect(readReceipt(root)).toMatchObject({ status: 'failed', errorCode: 'RECEIPT_OR_RUNNER_ERROR', gates: [] });
  });

  it.each(['receipt', 'state', 'harness'])('rejects a symlink at %s without overwriting its destination', target => {
    const root = fixture();
    config(root, [gate('unit')]);
    const external = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'gate-receipt-external-')));
    fixtures.push(external);
    const sentinel = path.join(external, 'gate-receipt.json');
    writeFileSync(sentinel, 'untouched');
    if (target === 'receipt') {
      mkdirSync(path.join(root, '.qwen-harness/state'));
      symlinkSync(sentinel, path.join(root, '.qwen-harness/state/gate-receipt.json'));
    } else if (target === 'state') {
      symlinkSync(external, path.join(root, '.qwen-harness/state'));
    } else {
      rmSync(path.join(root, '.qwen-harness'), { recursive: true });
      symlinkSync(external, path.join(root, '.qwen-harness'));
    }
    const result = execute(root);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('RUN ');
    expect(readFileSync(sentinel, 'utf8')).toBe('untouched');
  });

  it('binds untracked candidate content, ignores runtime outputs, and rejects edits during execution', () => {
    const root = fixture();
    config(root, [gate('unit')]);
    expect(execute(root).status).toBe(0);
    const original = readReceipt(root).contentHash;
    writeFileSync(path.join(root, 'new-source.txt'), 'new candidate');
    expect(execute(root).status).toBe(0);
    const changed = readReceipt(root).contentHash;
    expect(changed).not.toBe(original);
    writeFileSync(path.join(root, 'ignored-output.txt'), 'ignored');
    expect(execute(root).status).toBe(0);
    expect(readReceipt(root).contentHash).toBe(changed);
    config(root, [gate('mutating', "require('fs').writeFileSync('source.txt','changed by gate')")]);
    expect(execute(root).status).toBe(1);
    expect(readReceipt(root)).toMatchObject({ status: 'failed', errorCode: 'INPUTS_CHANGED', gates: [{ status: 'passed', exitCode: 0 }] });
  });

  it('hashes tracked deletions even when their parent directory is gone', () => {
    const root = fixture();
    mkdirSync(path.join(root, 'nested'));
    writeFileSync(path.join(root, 'nested/deleted.txt'), 'tracked');
    execFileSync('git', ['add', 'nested/deleted.txt'], { cwd: root });
    config(root, [gate('unit')]);
    expect(execute(root).status).toBe(0);
    const prior = readReceipt(root).contentHash;
    rmSync(path.join(root, 'nested'), { recursive: true });
    expect(execute(root).status).toBe(0);
    expect(readReceipt(root).contentHash).not.toBe(prior);
  });

  it('redacts known secrets and credential arguments while hashing and executing the original argv', () => {
    const root = fixture();
    writeFileSync(path.join(root, 'check.cjs'), 'process.exit(process.argv[2] === process.env.TEST_API_TOKEN ? 0 : 9);');
    const literalSecret = 'literal-credential-should-be-hidden';
    config(root, [gate('unit', '', { args: ['check.cjs', secret, '--password', literalSecret, 'api_key=hidden-value', 'https://user:password@example.invalid'] })]);
    const result = spawnSync(process.execPath, [runner], { cwd: root, encoding: 'utf8', timeout: 15_000, env: { ...process.env, TEST_API_TOKEN: secret } });
    expect(result.status, result.stderr).toBe(0);
    const receipt = readReceipt(root);
    expect(receipt.gates[0]).toMatchObject({ argvRedacted: true, status: 'passed', args: ['check.cjs', '[REDACTED]', '--password', '[REDACTED]', 'api_key=[REDACTED]', 'https://[REDACTED]@example.invalid'] });
    expect(receipt.gates[0].argvHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(receipt)).not.toContain(secret);
    expect(JSON.stringify(receipt)).not.toContain(literalSecret);
  });
});
