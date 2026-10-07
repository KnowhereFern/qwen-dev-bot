import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defaultProjectConfig, serializeProjectConfig } from '../src/core/config.js';
import type { PortfolioPlan } from '../src/core/types.js';
import { formatTerminalPlan, runInteractiveTerminal, terminalText } from '../src/terminal/interactive.js';
import type { TerminalIO, TerminalSnapshot } from '../src/terminal/interactive.js';
import { makeTmp } from './helpers.js';
import { homeScreen } from '../src/terminal/home.js';
import { renderTerminalScreen } from '../src/terminal/presentation.js';

function fixture(): TerminalSnapshot {
  const root = makeTmp('terminal');
  const config = defaultProjectConfig(root, 'Demo', 'owner/demo');
  const plan: PortfolioPlan = {
    id: 'plan-demo', projectId: 'demo', title: 'Demo delivery', objective: 'Deliver the demo',
    sourcePath: 'OBJECTIVE.md', contentHash: 'reviewed-hash', status: 'awaiting_initial_approval',
    constraints: ['Keep branding'], definitionOfDone: ['Live journey passes'],
    technologyDecisions: [{ id: 'NODE', category: 'runtime', technology: 'Node', source: 'approved', rationale: 'Preserve stack' }],
    deploymentDecisions: [{ id: 'STAGING', component: 'web', provider: 'Railway', environment: 'staging', authority: 'build-test-only', rationale: 'Existing staging' }],
    epicIssueNumber: 4, epicIssueUrl: 'https://github.test/owner/demo/issues/4',
    createdAt: 1, updatedAt: 5, approvedAt: null, revision: 5, currentWave: 1, repositorySha: 'abc123',
    stories: [{
      key: 'R5_S1', title: 'Order journey', goal: 'Complete ordering', acceptanceCriteria: ['Order test passes'],
      constraints: ['Keep budget'], requiredGateIds: ['unit', 'e2e'], rewardCriterionIds: ['review'], risk: 'medium',
      dependsOn: [], rollback: 'Revert', technologyDecisionIds: ['NODE'], deploymentDecisionIds: ['STAGING'],
      sourceIssueNumber: 82, sourceIssueUrl: 'https://github.test/owner/demo/issues/82', normalizedIssueNumber: null, normalizedIssueUrl: null,
      wave: 1, revision: 5,
    }],
  };
  return { config, plans: [plan], tasks: [] };
}

async function session(current: TerminalSnapshot, answers: Array<string | null>, execute?: (args: string[]) => Promise<number>) {
  const calls: string[][] = [];
  const output: string[] = [];
  let closed = false;
  const io: TerminalIO = {
    async question(prompt) { output.push(prompt); return answers.shift() ?? null; },
    print(value) { output.push(value); }, close() { closed = true; },
  };
  const result = await runInteractiveTerminal({
    root: current.config.project.root, io, snapshot: () => structuredClone(current),
    projects: () => [{ root: current.config.project.root, name: 'Demo' }], credential: () => null,
    workerStatus: async () => 'inactive',
    async execute(args) { calls.push(args); return execute ? execute(args) : 0; },
  });
  return { result, calls, output: output.join('\n'), closed };
}

describe('interactive terminal', () => {
  it('reviews a saved specification before setup without an approval action', async () => {
    const root = makeTmp('terminal-saved-spec');
    const answers = ['9', '3', '1', '0'];
    const calls: string[][] = [];
    await runInteractiveTerminal({ root, snapshot: () => { throw new Error('Not configured'); },
      specifications: () => [{ id: 'spec_test', createdAt: 'today', draft: { title: 'Memory engine' } }],
      projects: () => [], credential: () => null, workerStatus: async () => 'inactive',
      execute: async (args) => { calls.push(args); return 0; },
      io: { question: async () => answers.shift() ?? null, print() {}, close() {} },
    });
    expect(calls).toEqual([['spec-status', root, '--spec', 'spec_test']]);
  });

  it('creates a program from a saved specification without a handwritten requirements file', async () => {
    const current = fixture(); current.plans = [];
    const answers = ['2', '1', '1', '', '1', '0'];
    const calls: string[][] = [];
    await runInteractiveTerminal({ root: current.config.project.root, snapshot: () => current,
      specifications: () => [{ id: 'spec_test', createdAt: 'today', draft: { title: 'Memory engine' } }],
      credential: () => null, workerStatus: async () => 'inactive',
      execute: async (args) => { calls.push(args); return 0; },
      io: { question: async () => answers.shift() ?? null, print() {}, close() {} },
    });
    expect(calls).toEqual([['plan', current.config.project.root, '--spec', 'spec_test', '--max-stories', '25']]);
  });

  it('redrafts a specification-backed plan using its saved source', async () => {
    const current = fixture(); current.plans[0].sourcePath = 'harness-spec:spec_test';
    const answers = ['2', '1', 'feedback.md', '', '1', '0'];
    const calls: string[][] = [];
    await runInteractiveTerminal({ root: current.config.project.root, snapshot: () => current,
      specifications: () => [], credential: () => null, workerStatus: async () => 'inactive',
      execute: async (args) => { calls.push(args); return 0; },
      io: { question: async () => answers.shift() ?? null, print() {}, close() {} },
    });
    expect(calls).toEqual([['plan-redraft', current.config.project.root, '--plan', 'plan-demo', '--spec', 'spec_test', '--feedback', 'feedback.md', '--max-stories', '25']]);
  });

  it('drafts a private spec from a document before project setup without approving delivery', async () => {
    const root = makeTmp('terminal-spec');
    const answers = ['9', '1', 'idea.pdf', '1-4,6', '1', '0'];
    const calls: string[][] = [];
    await runInteractiveTerminal({ root, snapshot: () => { throw new Error('Not configured'); },
      projects: () => [], credential: () => null, workerStatus: async () => 'inactive',
      execute: async (args) => { calls.push(args); return 0; },
      io: { question: async () => answers.shift() ?? null, print() {}, close() {} },
    });
    expect(calls).toEqual([['spec', root, '--input', 'idea.pdf', '--pages', '1-4,6']]);
    expect(homeScreen({ root, connection: 'missing', worker: 'inactive' }).some((line) => line.text.includes('Next: 9'))).toBe(true);
  });

  it('drafts an idea using numbered menus and defaults new folders to spec intake', async () => {
    const root = makeTmp('terminal-idea');
    const picks = ['9', '2', '1', '0', '0'];
    const calls: string[][] = [];
    const menus: import('../src/terminal/menu.js').TerminalMenu[] = [];
    await runInteractiveTerminal({ root, snapshot: () => { throw new Error('Not configured'); },
      projects: () => [], credential: () => null, workerStatus: async () => 'inactive',
      execute: async (args) => { calls.push(args); return 0; },
      io: { select: async (menu) => { menus.push(menu); return picks.shift() ?? null; },
        question: async () => 'A reusable memory engine', print() {}, close() {} },
    });
    expect(calls).toEqual([['spec', root, '--idea', 'A reusable memory engine']]);
    expect(menus[0].initial).toBe('9');
  });

  it.each([
    ['9', '0', '0'],
    ['9', '1', '', '0'],
    ['9', '1', 'idea.pdf', '0', '0'],
    ['9', '2', 'An idea', '0', '0'],
    ['9', '1', '--approve', '0'],
  ])('does not execute cancelled or flag-like spec input: %j', async (...answers) => {
    const execute = vi.fn(async () => 0);
    await runInteractiveTerminal({ root: makeTmp('terminal-spec-cancel'),
      snapshot: () => { throw new Error('Not configured'); }, projects: () => [],
      credential: () => null, workerStatus: async () => 'inactive', execute,
      io: { question: async () => answers.shift() ?? null, print() {}, close() {} },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('offers a numbered dashboard return after a failed command without a text prompt', async () => {
    const current = fixture(); const picks = ['4', '0', '0'];
    const menus: import('../src/terminal/menu.js').TerminalMenu[] = [];
    const question = vi.fn(async () => null);
    await runInteractiveTerminal({ root: current.config.project.root, snapshot: () => current,
      credential: () => null, workerStatus: async () => 'inactive', execute: async () => 1,
      io: { select: async (menu) => { menus.push(menu); return picks.shift() ?? null; },
        question, print() {}, close() {} },
    });
    expect(menus.find((menu) => menu.title === 'Return to dashboard')?.choices).toEqual([
      { value: '0', label: 'Back to dashboard', description: 'Return without restarting or changing delivery.' },
    ]);
    expect(question).not.toHaveBeenCalled();
  });

  it('does not reinstall or restart an already running worker', async () => {
    const current = fixture(); current.plans[0]!.approvedAt = 1;
    const picks = ['7', '1', '0', '0']; const execute = vi.fn(async () => 0);
    const print = vi.fn();
    await runInteractiveTerminal({ root: current.config.project.root, snapshot: () => current,
      credential: () => null, workerStatus: async () => 'running', execute,
      io: { select: async () => picks.shift() ?? null, question: async () => null, print, close() {} },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(print.mock.calls.flat().join(' ')).toContain('already running');
  });

  it('approves through two numbered decisions while preserving exact revision and hash', async () => {
    const current = fixture(); const picks = ['1', '1', '12', '1', '0'];
    const menus: import('../src/terminal/menu.js').TerminalMenu[] = [];
    const execute = vi.fn(async (_args: string[]) => 0);
    await runInteractiveTerminal({ root: current.config.project.root, snapshot: () => current,
      credential: () => null, workerStatus: async () => 'inactive', execute,
      io: { select: async (menu) => { menus.push(menu); return picks.shift() ?? null; },
        document: async () => {}, question: async () => '', print() {}, close() {} },
    });
    expect(menus.every((menu) => menu.choices.every((choice) => /^\d+$/.test(choice.value)))).toBe(true);
    expect(menus.find((menu) => menu.title === 'Approve revision 5')?.initial).toBe('0');
    expect(execute).toHaveBeenCalledExactlyOnceWith(['plan-approve', current.config.project.root, '--plan', 'plan-demo', '--revision', '5', '--hash', 'reviewed-hash']);
  });
  it('reviews every plan section in the reader, then cancels numbered approval without writes', async () => {
    const current = fixture();
    const selections = ['1', '1', ...Array.from({ length: 10 }, (_, i) => String(i + 1)), '11', '12', '0', '0'];
    const answers = ['', ''];
    const document = vi.fn(async (_title: string, _text: string) => {});
    const execute = vi.fn(async (_args: string[]) => 0);
    const question = vi.fn(async () => answers.shift() ?? null);
    await runInteractiveTerminal({ root: current.config.project.root, snapshot: () => current,
      credential: () => null, workerStatus: async () => 'inactive', execute,
      io: { select: async () => selections.shift() ?? null, document, question, print() {}, close() {} },
    });
    expect(document).toHaveBeenCalledTimes(11);
    expect(document.mock.calls.map((call) => call[0])).toEqual(['Overview', 'Objective', 'Acceptance criteria', 'Constraints', 'Technology decisions', 'Deployment authority', 'Coverage & evidence', 'Delivery steps', 'Revision history', 'Required checks', 'Complete plan']);
    expect(execute).not.toHaveBeenCalled();
    expect(question.mock.calls.flat().join(' ')).not.toContain('Type approve');
  });

  it.each([
    ['4'], ['3', '2'], ['5', '1'], ['5', '2'], ['5', '3'], ['5', '4', '1'], ['5', '5'],
    ['6', '0'], ['6', '1'], ['6', '2'], ['6', '3'], ['7', '1'], ['7', '2'], ['7', '3'],
    ['8', '0'], ['8', '1', '1'], ['8', '1', '2'], ['8', '1', '3'], ['8', '1', '4'], ['8', '2'], ['8', '3'], ['2', '1'],
  ])('keeps native path %j inside the shared action shell', async (...path: string[]) => {
    const current = fixture(); const selections = [...path, '0'];
    const begin = vi.fn(); const finish = vi.fn(async () => {}); const close = vi.fn();
    const execute = vi.fn(async (_args: string[]) => 0);
    await runInteractiveTerminal({ root: current.config.project.root, snapshot: () => current,
      credential: () => null, workerStatus: async () => 'inactive', execute,
      io: { select: async () => selections.shift() ?? null, document: async () => {}, begin, finish,
        question: async () => null, secret: async () => null, print() {}, close },
    });
    expect(begin).toHaveBeenCalledOnce(); expect(finish).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
    expect(execute.mock.calls.every(([args]) => !['init', 'update', 'plan', 'plan-redraft', 'plan-approve', 'reconcile', 'verify'].includes(args[0]))).toBe(true);
  });
  it('native navigation keeps results visible and does not bypass approval confirmation', async () => {
    const current = fixture();
    const selections = ['1', '1', '0'];
    const answers = ['1', 'wrong confirmation', ''];
    const execute = vi.fn(async () => 0);
    const question = vi.fn(async () => answers.shift() ?? null);
    const print = vi.fn();
    await runInteractiveTerminal({ root: current.config.project.root, snapshot: () => current,
      credential: () => null, workerStatus: async () => 'inactive', execute,
      io: { select: async () => selections.shift() ?? null, question, print, close() {} },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(question.mock.calls.flat().join(' ')).not.toContain('Type approve');
    expect(question.mock.calls.flat().join(' ')).not.toContain('Press Enter to return');
    expect(print).toHaveBeenCalledWith('Cancelled; no approval was recorded.');
  });

  it('keeps command failures in the shared results shell', async () => {
    const current = fixture(); const picks = ['4']; const print = vi.fn(); const finish = vi.fn(async () => {});
    await runInteractiveTerminal({ root: current.config.project.root, snapshot: () => current,
      credential: () => null, workerStatus: async () => 'inactive', execute: async () => 1,
      io: { select: async () => picks.shift() ?? null, question: async () => null, begin() {}, finish, print, close() {} },
    });
    expect(print.mock.calls.flat().join('\n')).toContain('doctor failed');
    expect(finish).toHaveBeenCalledOnce();
  });

  it('uses the live reader without running a recovery cycle', async () => {
    const current = fixture(); const picks = ['3', '1']; const execute = vi.fn();
    const live = vi.fn(async (_title: string, read: () => Promise<string>) => { expect(await read()).toContain('Demo'); });
    await runInteractiveTerminal({ root: current.config.project.root, snapshot: () => current,
      credential: () => null, workerStatus: async () => 'inactive', execute,
      io: { select: async () => picks.shift() ?? null, live, question: async () => null, print() {}, close() {} },
    });
    expect(live).toHaveBeenCalledOnce(); expect(execute).not.toHaveBeenCalled();
  });

  it('opens and exits without approval, Qwen requests, or worker side effects', async () => {
    const result = await session(fixture(), ['0']);
    expect(result.calls).toEqual([]);
    expect(result.closed).toBe(true);
    expect(result.output).toContain('Opening this console never approves or starts delivery.');
  });

  it('shows exact contracts, evidence and authority without counting superseded proposals', () => {
    const current = fixture();
    const plan = current.plans[0];
    plan.stories.push({ ...plan.stories[0], key: 'R4_S1', title: 'Old proposal', supersededAt: 3, revision: 4 });
    const output = formatTerminalPlan(plan);
    expect(output).toContain('1 current stories / 1 waves');
    expect(output).toContain('1 superseded stories');
    expect(output).not.toContain('Old proposal');
    expect(output).toContain('Order test passes');
    expect(output).toContain('Required checks: unit, e2e');
    expect(output).toContain('Railway/staging');
    expect(output).toContain('Assessed commit: abc123');
  });

  it('requires numbered confirmation and passes exact revision/hash guards to approval', async () => {
    const current = fixture();
    const result = await session(current, ['1', '1', '1', '1', '0']);
    expect(result.calls).toEqual([['plan-approve', current.config.project.root, '--plan', 'plan-demo', '--revision', '5', '--hash', 'reviewed-hash']]);
    expect(result.output).toContain('already-running worker may pick it up immediately');
    expect(result.calls.some((call) => call.includes('--install-service'))).toBe(false);
  });

  it.each(['', 'yes', 'approve revision 4'])('does not approve on %j', async (confirmation) => {
    const result = await session(fixture(), ['1', '1', '1', confirmation, '0']);
    expect(result.calls).toEqual([]);
    expect(result.output).toContain('Cancelled; no approval');
  });

  it('routes material approval through the same explicit boundary', async () => {
    const current = fixture();
    current.plans[0].status = 'awaiting_material_approval';
    current.plans[0].approvedAt = 1;
    const result = await session(current, ['1', '1', '1', '1', '0']);
    expect(result.calls[0][0]).toBe('plan-approve-revision');
  });

  it('requests a review-only redraft using project feedback, never approval', async () => {
    const current = fixture();
    const result = await session(current, ['1', '1', '2', '', 'review.md', '', '1', '0']);
    expect(result.calls).toEqual([['plan-redraft', current.config.project.root, '--plan', 'plan-demo', '--requirements', 'OBJECTIVE.md', '--feedback', 'review.md', '--max-stories', '25']]);
    expect(result.output).toContain('drafting never approves');
  });

  it('does not redraft approved objectives through the initial-plan interaction', async () => {
    const current = fixture();
    current.plans[0].status = 'awaiting_material_approval';
    current.plans[0].approvedAt = 1;
    const result = await session(current, ['1', '1', '2', '0']);
    expect(result.calls).toEqual([]);
    expect(result.output).toContain('cannot change the frozen objective');
  });

  it('creates a new draft only after explicit provider-call confirmation', async () => {
    const current = fixture();
    current.plans = [];
    const result = await session(current, ['2', 'OBJECTIVE.md', '40', '1', '0']);
    expect(result.calls).toEqual([['plan', current.config.project.root, '--requirements', 'OBJECTIVE.md', '--max-stories', '40']]);
  });

  it('keeps the console available after stale approval or provider failures', async () => {
    const result = await session(fixture(), ['1', '1', '1', '1', '3', '2', '0'], async (args) => {
      if (args[0] === 'plan-approve') throw new Error('The program changed since review.');
      return 0;
    });
    expect(result.calls.map((call) => call[0])).toEqual(['plan-approve', 'status']);
    expect(result.output).toContain('program changed since review');
    expect(result.closed).toBe(true);
  });

  it('requires a separate confirmation to start the shared worker', async () => {
    const current = fixture();
    current.plans[0].status = 'active';
    current.plans[0].approvedAt = 1;
    const cancelled = await session(current, ['7', '1', '', '0']);
    expect(cancelled.calls).toEqual([]);
    const started = await session(current, ['7', '1', '1', '0']);
    expect(started.calls[0]).toEqual(['update', expect.any(String), '--install-service']);
    expect(started.output).toContain('ALL enabled registered projects');
  });

  it('will not initiate execution before initial program approval', async () => {
    const result = await session(fixture(), ['7', '1', '0']);
    expect(result.calls).toEqual([]);
    expect(result.output).toContain('Approve a program before initiating');
  });

  it('runs a bounded cycle only for approved work and explicit confirmation', async () => {
    const current = fixture();
    current.plans[0].status = 'active';
    current.plans[0].approvedAt = 1;
    const result = await session(current, ['7', '2', '1', '0']);
    expect(result.calls).toEqual([['reconcile', current.config.project.root]]);
  });

  it('exits cleanly on EOF and rejects invalid program selection', async () => {
    const result = await session(fixture(), ['1', '99', null]);
    expect(result.calls).toEqual([]);
    expect(result.closed).toBe(true);
    expect(result.output).toContain('Invalid program number');
  });

  it('selects a registered project without needing an ID', async () => {
    const current = fixture();
    const answers = ['1', '0'];
    let selectedRoot: string | undefined;
    await runInteractiveTerminal({
      io: { async question() { return answers.shift() ?? null; }, print() {}, close() {} },
      projects: () => [{ root: current.config.project.root, name: 'Demo' }],
      snapshot(root) { selectedRoot = root; return current; }, execute: async () => 0,
    });
    // No explicit root: choose the registry if the checkout itself is not initialized.
    expect(selectedRoot).toBe(current.config.project.root);
  });

  it('removes ANSI/OSC terminal injection and redacts credentials', () => {
    expect(terminalText('\x1b[2Jsafe\x1b]0;injected\x07\x1b[31m')).toBe('safe');
    expect(terminalText('Bearer super-secret')).not.toContain('super-secret');
  });

  it('rejects non-terminal interactive invocation without hanging; no-argument automation still gets help', () => {
    const bin = fileURLToPath(new URL('../bin/qwen-harness.mjs', import.meta.url));
    const interactive = spawnSync(process.execPath, [bin, 'interactive'], { encoding: 'utf8', timeout: 10_000 });
    expect(interactive.status).toBe(1);
    expect(interactive.stderr).toContain('Interactive mode requires a terminal');
    const automated = spawnSync(process.execPath, [bin], { encoding: 'utf8', timeout: 10_000 });
    expect(automated.status).toBe(0);
    expect(automated.stdout).toContain('Usage: fern-harness');
    expect(automated.stdout).toContain('Compatibility alias: qwen-harness');
    const json = spawnSync(process.execPath, [bin, 'interactive', '--json'], { encoding: 'utf8', timeout: 10_000 });
    expect(json.status).toBe(1);
    expect(json.stderr).toContain('Interactive mode does not support --json');
  });

  it('offers setup for an unconfigured folder without forcing an external command', async () => {
    const current = fixture();
    const answers = ['6', '1', 'Demo', 'owner/demo', 'owner', '1', '1', '0'];
    const calls: string[][] = [];
    const output: string[] = [];
    await runInteractiveTerminal({
      root: current.config.project.root,
      snapshot() { throw new Error('Missing configuration'); },
      credential: () => null,
      io: { question: async () => answers.shift() ?? null, print: (text) => output.push(text), close() {} },
      async execute(args) { calls.push(args); return 0; },
    });
    expect(calls[0]).toEqual(['init', current.config.project.root, '--yes', '--name', 'Demo', '--repo', 'owner/demo', '--trusted-author', 'owner', '--install-qwen', '--no-service', '--install-cli', '--link-extension', '--configure-github']);
    expect(output.join('\n')).toContain('Unconfigured project');
    expect(calls.some((call) => call[0] === 'plan-approve' || call.includes('--install-service'))).toBe(false);
  });

  it('configures a Token Plan route while preserving the model and never starting a worker', async () => {
    const current = fixture();
    const result = await session(current, ['8', '1', '2', '', '', '1', '0']);
    expect(result.calls[0]).toEqual(['update', current.config.project.root, '--billing-plan', 'token-plan-personal', '--base-url', 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', '--api-key-env', 'BAILIAN_TOKEN_PLAN_API_KEY', '--no-service', '--skip-dependencies']);
    expect(result.calls[0]).not.toContain('--model');
  });

  it('never tests the live provider simply by viewing connection status', async () => {
    const viewed = await session(fixture(), ['8', '0', '0']);
    expect(viewed.calls).toEqual([]);
    const verified = await session(fixture(), ['8', '3', '1', '0']);
    expect(verified.calls).toEqual([['verify', expect.any(String)]]);
  });

  it('labels a successful connection test truthfully for this session', async () => {
    const current = fixture();
    const answers = ['8', '3', '1', '0'];
    const output: string[] = [];
    await runInteractiveTerminal({ root: current.config.project.root, snapshot: () => current,
      credential: () => ({ apiKey: 'opaque-fixture-key', envKey: current.config.qwen.credentialEnvKey, source: 'Qwen user .env' }), execute: async () => 0,
      io: { question: async () => answers.shift() ?? null, print: (text) => output.push(text), close() {} },
    });
    expect(output.join('\n')).toContain('Connection: live verified this session');
    expect(output.join('\n')).not.toContain('opaque-fixture-key');
  });

  it('uses the real CLI subprocess for read-only task status with isolated state', async () => {
    const current = fixture();
    mkdirSync(path.join(current.config.project.root, '.qwen-harness'));
    writeFileSync(path.join(current.config.project.root, '.qwen-harness', 'project.yml'), serializeProjectConfig(current.config));
    vi.stubEnv('QWEN_HARNESS_STATE_DIR', makeTmp('terminal-cli-state'));
    const answers = ['3', '2', '0'];
    const output: string[] = [];
    try {
      await runInteractiveTerminal({ root: current.config.project.root, snapshot: () => current, credential: () => null,
        io: { question: async () => answers.shift() ?? null, print: (text) => output.push(text), close() {} },
      });
      expect(output.join('\n')).toContain('Counts: {}');
      expect(output.join('\n')).not.toContain('Error:');
    } finally { vi.unstubAllEnvs(); }
  });

  it('saves a hidden credential without putting the key in output or command arguments', async () => {
    const current = fixture();
    const answers = ['8', '2', '1', '0'];
    const key = `sk-${'a'.repeat(24)}`;
    const output: string[] = [];
    const save = vi.fn();
    const execute = vi.fn(async () => 0);
    await runInteractiveTerminal({
      root: current.config.project.root, snapshot: () => current, credential: () => null, saveCredential: save,
      io: { question: async () => answers.shift() ?? null, secret: async () => key, print: (text) => output.push(text), close() {} }, execute,
    });
    expect(save).toHaveBeenCalledWith(current.config.qwen.credentialEnvKey, key);
    expect(execute).not.toHaveBeenCalled();
    expect(output.join('\n')).not.toContain(key);
  });

  it('does not turn a requirements filename into an approval flag', async () => {
    const current = fixture();
    current.plans = [];
    const result = await session(current, ['2', '--approve', '0']);
    expect(result.calls).toEqual([]);
    expect(result.output).toContain('filenames cannot act as CLI flags');
  });

  it('opens GitHub sign-in only after explicit confirmation', async () => {
    const current = fixture();
    const answers = ['6', '3', '1', '0'];
    const login = vi.fn(async () => 0);
    const execute = vi.fn(async () => 0);
    await runInteractiveTerminal({ root: current.config.project.root, snapshot: () => current, credential: () => null, loginGitHub: login, execute,
      io: { question: async () => answers.shift() ?? null, print() {}, close() {} },
    });
    expect(login).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not run any connection or setup action when cancelled', async () => {
    const result = await session(fixture(), ['6', '0', '8', '1', '2', '', '', '', '0']);
    expect(result.calls).toEqual([]);
  });

  it('keeps live progress read-only, refreshes changed state, and cleans up its timer on exit', async () => {
    vi.useFakeTimers();
    try {
      const current = fixture();
      const answers = ['3', '1', '0'];
      const output: string[] = [];
      let finishWatch: ((value: string) => void) | undefined;
      const execute = vi.fn(async () => 0);
      const running = runInteractiveTerminal({
        root: current.config.project.root, snapshot: () => current, credential: () => null,
        workerStatus: async () => 'inactive', refreshMs: 100, execute,
        io: { question: async (prompt) => prompt === '0 · Back to dashboard (Enter also returns): ' ? new Promise<string>((resolve) => { finishWatch = resolve; }) : answers.shift() ?? null, print: (text) => output.push(text), close() {} },
      });
      await vi.advanceTimersByTimeAsync(10);
      current.plans[0].status = 'active';
      await vi.advanceTimersByTimeAsync(100);
      expect(output.join('\n')).toContain('Waiting for your approval');
      expect(output.join('\n')).toContain('Approved for delivery');
      expect(output.join('\n')).toContain('stage 1');
      finishWatch?.('0');
      await running;
      expect(execute).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('explains approval, proposed steps, empty work and an untested connection in plain language', () => {
    const current = fixture();
    current.plans[0].stories.push({ ...current.plans[0].stories[0], key: 'old', supersededAt: 3 });
    const output = renderTerminalScreen(homeScreen({ root: current.config.project.root, snapshot: current, connection: 'found', worker: 'inactive' }));
    expect(output).toContain('Waiting for your approval');
    expect(output).toContain('1 delivery step in 1 stage');
    expect(output).toContain('version 5 · not started');
    expect(output).toContain('Not scheduled until you approve');
    expect(output).toContain('Key found · not tested this session');
    expect(output).toContain('Background worker is not running');
    expect(output).toContain('Next: 1 — Review the delivery plan');
    expect(output).not.toMatch(/awaiting_initial_approval|wave|Approvals:|Tasks: 0 unfinished/);
  });

  it('does not present an approved plan as actively executing when the worker is inactive', () => {
    const current = fixture();
    current.plans[0].approvedAt = 1;
    current.plans[0].status = 'active';
    const output = renderTerminalScreen(homeScreen({ root: current.config.project.root, snapshot: current, connection: 'found', worker: 'inactive' }));
    expect(output).toContain('Approved for delivery');
    expect(output).toContain('Background worker is not running');
    expect(output).toContain('Next: 8 — Test the AI connection');
    expect(output).not.toContain('not started');
  });

  it('renders the styled screen without introducing any approval, provider or execution action', async () => {
    const current = fixture();
    const screen = vi.fn();
    const execute = vi.fn(async () => 0);
    await runInteractiveTerminal({ root: current.config.project.root, snapshot: () => current, credential: () => null,
      workerStatus: async () => 'inactive', execute,
      io: { question: async () => '0', print() {}, screen, close() {} },
    });
    expect(screen).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });
});
