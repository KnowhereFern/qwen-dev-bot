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
      '.qwen/workflows/harness-implement.js exactly once using its scriptPath',
    );
    expect(renderObjective(task, [], '/tmp/project/.qwen/workflows/harness-implement.js')).toContain(
      '/tmp/project/.qwen/workflows/harness-implement.js exactly once using its scriptPath',
    );
  });

  it('replaces a completed Goal for verifier-driven repair while retaining the session', () => {
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
    expect(repair).toMatch(/^\/goal Implement the normalized GitHub task/);
    expect(repair).not.toContain('/goal edit');
    expect(repair).toContain('unit gate failed');
  });
});
