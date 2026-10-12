import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { qwenCodeVersionAtLeast } from '../src/qwen/runtime-compat.js';
import {
  classifyGoalDisposition,
  goalDetailsFromStreamEvent,
  goalPromptFor,
  renderObjective,
} from '../src/qwen/qwen-code-executor.js';
import type { TaskRecord } from '../src/core/types.js';

const root = path.resolve(import.meta.dirname, '..');

describe('Qwen extension packaging', () => {
  it('classifies canonical Goal snapshots and bounds non-budget pauses', () => {
    expect(goalDetailsFromStreamEvent({
      type: 'stream_event',
      event: {
        type: 'goal_state',
        goal_state: { goal: { status: 'usage_limited', lastReason: 'Session token limit reached', limitKind: 'tokens' } },
      },
    })).toEqual({ state: 'usage_limited', reason: 'Session token limit reached', limitKind: 'tokens' });
    expect(classifyGoalDisposition({ budgetExit: true, state: 'paused' })).toBe('continue');
    expect(classifyGoalDisposition({ budgetExit: false, state: 'active' })).toBe('retry');
    expect(classifyGoalDisposition({ budgetExit: false, state: 'paused', reason: 'manual pause' })).toBe('retry');
    expect(classifyGoalDisposition({ budgetExit: false, state: 'blocked', reason: 'no progress' })).toBe('retry');
    expect(classifyGoalDisposition({ budgetExit: false, state: 'usage_limited' })).toBe('continue');
    expect(classifyGoalDisposition({ budgetExit: false, state: 'complete' })).toBe('complete');
  });
  it('keeps extension-loaded agents and reward skill in sync with project templates', () => {
    const agentNames = readdirSync(path.join(root, 'agents')).sort();
    expect(agentNames).toHaveLength(6);
    for (const name of agentNames) {
      const agent = readFileSync(path.join(root, 'agents', name), 'utf8');
      expect(agent).toBe(readFileSync(path.join(root, 'template', '.qwen', 'agents', name), 'utf8'));
      expect(agent).toMatch(/^maxTurns: \d+$/m);
      if (name === 'harness-implementer.md') expect(agent).toContain('approvalMode: yolo');
    }
    for (const name of ['SKILL.md', 'resources.yaml']) {
      expect(readFileSync(path.join(root, 'skills', 'harness-reward', name), 'utf8')).toBe(
        readFileSync(path.join(root, 'template', '.qwen', 'skills', 'harness-reward', name), 'utf8'),
      );
    }
    const manifest = JSON.parse(readFileSync(path.join(root, 'qwen-extension.json'), 'utf8'));
    expect(manifest).toMatchObject({
      name: 'qwen-dev-harness',
      contextFileName: 'DELIVERY-HARNESS.md',
    });
  });

  it('parses the saved workflow in the same async wrapper used by Qwen Code', () => {
    const source = readFileSync(
      path.join(root, 'template', '.qwen', 'workflows', 'harness-implement.js'),
      'utf8',
    );
    expect(() => {
      // Qwen Code injects these globals and evaluates saved workflow bodies inside an async IIFE.
      new Function('phase', 'parallel', 'agent', 'args', 'log', `return (async () => {\n${source}\n})();`);
    }).not.toThrow();
  });

  it('requires the Qwen Code release that provides durable headless Goal controls', () => {
    expect(qwenCodeVersionAtLeast('qwen-code 0.22.1')).toBe(true);
    expect(qwenCodeVersionAtLeast('0.23.0')).toBe(true);
    expect(qwenCodeVersionAtLeast('0.22.0')).toBe(false);
    expect(qwenCodeVersionAtLeast('not installed')).toBe(false);
  });

  it('keeps machine evidence discoverable even when workflow reports are long', async () => {
    const source = readFileSync(path.join(root, 'template', '.qwen', 'workflows', 'harness-implement.js'), 'utf8');
    const prompts: Array<{ prompt: string; agentType: string }> = [];
    const run = new Function('phase', 'parallel', 'agent', 'args', 'log', `return (async () => {\n${source}\n})();`);
    const result = await run(
      () => {},
      (calls: Array<() => Promise<unknown>>) => Promise.all(calls.map(call => call())),
      async (prompt: string, options: { agentType: string }) => {
        prompts.push({ prompt, agentType: options.agentType });
        return options.agentType === 'harness-reviewer'
          ? { passed: false, findings: ['missing receipt'] }
          : { summary: 'verbose report '.repeat(2000), changedFiles: [], tests: ['claimed pass'] };
      },
      { taskId: 'fixture' },
      () => { throw new Error('Do not duplicate verbose reports in logs'); },
    );
    expect(JSON.stringify(result).slice(0,1000)).toContain('gateReceiptPath');
    expect(result.gateReceiptPath).toBe('.qwen-harness/state/gate-receipt.json');
    expect(result.review.passed).toBe(false);
    expect(prompts.map(item => item.agentType)).toEqual([
      'harness-researcher', 'harness-verifier', 'harness-implementer', 'harness-reviewer',
    ]);
    expect(prompts[2]!.prompt).toContain('After your final code edit, execute node .qwen-harness/scripts/run-gates.mjs');
    expect(prompts[2]!.prompt).toContain('never author or edit the receipt yourself');
    expect(prompts[2]!.prompt).toContain('Act on any existing candidate early');
    expect(prompts[2]!.prompt).toContain('add the tests before another broad survey');
    expect(prompts[2]!.prompt).toContain('run verification rather than re-planning it');
    expect(prompts[2]!.prompt).toContain('Preserve every acceptance criterion');
    expect(prompts[2]!.prompt).toContain('Use the independent reconnaissance below as your starting point');
    expect(prompts[3]!.prompt).toContain('A missing, incomplete, failed, stale, or wrong-worktree receipt is a blocker');
    expect(prompts[3]!.prompt).toContain('Do not edit files or attempt shell tools');
  });

  it('skips only reconnaissance on a focused continuation while keeping gates and review', async () => {
    const source = readFileSync(path.join(root, 'template', '.qwen', 'workflows', 'harness-implement.js'), 'utf8');
    const prompts: Array<{ prompt: string; agentType: string }> = [];
    const run = new Function('phase', 'parallel', 'agent', 'args', 'log', `return (async () => {\n${source}\n})();`);
    const result = await run(
      () => {},
      (calls: Array<() => Promise<unknown>>) => { throw new Error('reconnaissance must be skipped on a focused continuation'); },
      async (prompt: string, options: { agentType: string }) => {
        prompts.push({ prompt, agentType: options.agentType });
        return options.agentType === 'harness-reviewer'
          ? { passed: false, findings: ['missing receipt'] }
          : { summary: 'focused step done', changedFiles: [], tests: [] };
      },
      { taskId: 'fixture', executionFocus: { nextAction: 'write missing acceptance tests' } },
      () => {},
    );
    expect(prompts.map(item => item.agentType)).toEqual(['harness-implementer', 'harness-reviewer']);
    expect(prompts[0]!.prompt).toContain('focused continuation');
    expect(prompts[0]!.prompt).toContain('Next action from the coordinator: write missing acceptance tests');
    expect(prompts[0]!.prompt).toContain('skip redundant reconnaissance');
    expect(prompts[0]!.prompt).toContain('After your final code edit, execute node .qwen-harness/scripts/run-gates.mjs');
    expect(prompts[0]!.prompt).toContain('never author or edit the receipt yourself');
    expect(prompts[0]!.prompt).toContain('"taskId":"fixture"');
    expect(prompts[1]!.prompt).toContain('A missing, incomplete, failed, stale, or wrong-worktree receipt is a blocker');
    expect(prompts[1]!.prompt).toContain('Do not edit files or attempt shell tools');
    expect(result.gateReceiptPath).toBe('.qwen-harness/state/gate-receipt.json');
    expect(result.evidenceInstruction).toContain('machine-written gate receipt');
  });

  it('fails safe to full reconnaissance when executionFocus is missing or malformed', async () => {
    const source = readFileSync(path.join(root, 'template', '.qwen', 'workflows', 'harness-implement.js'), 'utf8');
    const run = new Function('phase', 'parallel', 'agent', 'args', 'log', `return (async () => {\n${source}\n})();`);
    const agentTypesByRun: Array<string[]> = [];
    for (const badArgs of [
      { taskId: 'fixture' },
      { taskId: 'fixture', executionFocus: null },
      { taskId: 'fixture', executionFocus: 'write tests' },
      { taskId: 'fixture', executionFocus: {} },
      { taskId: 'fixture', executionFocus: { nextAction: '   ' } },
      { taskId: 'fixture', executionFocus: { nextAction: 42 } },
    ]) {
      const agentTypes: string[] = [];
      await run(
        () => {},
        (calls: Array<() => Promise<unknown>>) => Promise.all(calls.map(call => call())),
        async (_prompt: string, options: { agentType: string }) => {
          agentTypes.push(options.agentType);
          return options.agentType === 'harness-reviewer'
            ? { passed: true, findings: [] }
            : { summary: 'done', changedFiles: [], tests: [] };
        },
        badArgs,
        () => {},
      );
      agentTypesByRun.push(agentTypes);
    }
    expect(agentTypesByRun).toHaveLength(6);
    for (const agentTypes of agentTypesByRun) {
      expect(agentTypes).toEqual([
        'harness-researcher', 'harness-verifier', 'harness-implementer', 'harness-reviewer',
      ]);
    }
  });

  it('keeps the installed implementer focused on finishing saved work without weakening gates', () => {
    const agent = readFileSync(path.join(root, 'template', '.qwen', 'agents', 'harness-implementer.md'), 'utf8');
    expect(agent).toContain('Act on an existing candidate early');
    expect(agent).toContain('instead of repeating broad read/grep surveys');
    expect(agent).toContain('add the tests before another broad survey');
    expect(agent).toContain('run the required gates rather than re-planning it');
    expect(agent).toContain('Never weaken an acceptance criterion, gate, or review');
  });

  it('requires the supervisor-owned Goal to invoke the bounded saved workflow', () => {
    const task = {
      id: 'task-example',
      issueNumber: 7,
      title: 'Example',
      body: 'Implement the example.',
      author: 'owner',
      spec: null,
    } as TaskRecord;
    expect(renderObjective(task, [])).toContain(
      '.qwen/workflows/harness-implement.js exactly once per execution or verifier-repair attempt using its scriptPath',
    );
    expect(renderObjective(task, [], '/tmp/project/.qwen/workflows/harness-implement.js')).toContain(
      '/tmp/project/.qwen/workflows/harness-implement.js exactly once per execution or verifier-repair attempt using its scriptPath',
    );
    const objective = renderObjective(task, []);
    expect(objective).toContain('You are the delivery coordinator, not the implementation writer.');
    expect(objective).toContain('never call run_shell_command, exec, edit, write_file, notebook_edit, or agent directly');
    expect(objective).toContain('Delegate all shell commands, tests, and file mutations to the saved workflow implementer.');
    expect(objective).toContain('a denied tool call does not authorize a workaround');
    expect(objective).toContain('same args and resumeFromRunId; do not start a duplicate writer');
    expect(objective).toContain('LOCAL IMPLEMENTATION PHASE');
    expect(objective).toContain('The external deterministic supervisor runs AFTER this Goal returns');
    expect(objective).toContain('An unpushed candidate or absent PR alone is not a blocker for this local Goal');
    expect(objective).toContain('Those downstream delivery invariants remain mandatory');
    expect(objective).toContain('the saved workflow review passes, and the required project checks pass');
    expect(objective).toContain('Preserve every acceptance criterion');
    expect(objective).toContain('is not a successful handoff');
    expect(objective).toContain('use read_file to read .qwen-harness/state/gate-receipt.json');
    expect(objective).toContain('Read all gate entries in bounded pages');
    expect(objective).toContain('model-written test summary is not execution evidence');
    expect(objective).toContain('never replaces the supervisor\'s independent exact-commit verification');
  });

  it('starts a fresh Goal for verifier-driven repair while retaining the task contract', () => {
    const task = {
      id: 'task-repair',
      issueNumber: 8,
      title: 'Repair example',
      body: 'Fix the failing gate.',
      author: 'owner',
      spec: null,
      qwenSessionId: 'session-1',
    } as TaskRecord;
    expect(goalPromptFor(task, [])).toBe('/goal resume');
    const repair = goalPromptFor(task, ['unit gate failed']);
    expect(repair).toMatch(/^\/goal You are the delivery coordinator/);
    expect(repair).not.toContain('/goal edit');
    expect(repair).toContain('unit gate failed');
    expect(repair).toContain('exactly once per execution or verifier-repair attempt');
    expect(repair).toContain('start a fresh workflow without resumeFromRunId and include all verifier feedback in its args');
    expect(repair).toContain('LOCAL IMPLEMENTATION PHASE');
    expect(repair).toContain('Do not push, create a PR, merge, deploy');
  });
});
