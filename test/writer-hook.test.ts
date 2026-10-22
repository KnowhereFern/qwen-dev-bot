import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, it } from 'vitest';
import { makeTmp } from './helpers.js';

let worktree: string;
let workflow: string;
beforeEach(() => {
  worktree = makeTmp('writer-hook');
  workflow = path.join(worktree, 'workflow.js');
  writeFileSync(workflow, '// fixture');
});
const script = path.resolve('hooks/enforce-writer.mjs');
const payload = (tool_name = 'write_file', tool_input: Record<string, unknown> = {}) => ({ hook_event_name: 'PreToolUse', cwd: worktree, tool_name, tool_input });
function invoke(input: unknown, environment: Record<string, string> = {}) {
  return spawnSync(process.execPath, [script], {
    input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 5000,
    env: { QWEN_HARNESS_WRITER_GUARD: '1', QWEN_HARNESS_WORKTREE: worktree, QWEN_HARNESS_WORKFLOW_PATH: workflow, ...environment },
  });
}

function recordedChild(role = 'harness-implementer') {
  const project = makeTmp('writer-transcript');
  const session = 'fixture-session';
  const agent = 'workflow-agent-0123456789abcdef';
  const directory = path.join(project, 'subagents', session);
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `agent-${agent}.jsonl`);
  const header = { type: 'user', isSidechain: true, agentId: agent, agentName: role, sessionId: session, cwd: worktree };
  writeFileSync(file, `${JSON.stringify(header)}\n`);
  return { input: { ...payload(), agent_id: agent, session_id: session, transcript_path: path.join(project, 'chats', `${session}.jsonl`) }, file, header };
}

it('is inert outside guarded execution, even with malformed input', () => {
  const result = invoke('not json', { QWEN_HARNESS_WRITER_GUARD: '0' });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('');
});

it.each(['run_shell_command', 'Shell', 'Bash', 'edit', 'Edit', 'write_file', 'WriteFile', 'Write', 'notebook_edit', 'NotebookEdit', 'monitor', 'agent', 'Task', 'exec'])('denies parent %s without echoing tool input', (tool) => {
  const result = invoke(payload(tool, { command: 'private-fixture' }));
  expect(result.status).toBe(2);
  expect(result.stderr).not.toContain('private-fixture');
  expect(result.stdout).toBe('');
});

it('permits only the exact saved workflow', () => {
  expect(invoke(payload('workflow', { scriptPath: workflow, args: {} })).status).toBe(0);
  expect(invoke(payload('workflow', { scriptPath: workflow, script: 'inline' })).status).toBe(2);
  expect(invoke(payload('workflow', { name: 'harness-implement' })).status).toBe(2);
  expect(invoke(payload('workflow', { scriptPath: `${workflow}.other` })).status).toBe(2);
});

it('refuses wrong worktrees, malformed payloads and missing configuration', () => {
  expect(invoke({ ...payload(), cwd: makeTmp('wrong-worktree') }).status).toBe(2);
  for (const input of ['{', 'null', '[]', '{}']) expect(invoke(input).status).toBe(2);
  expect(invoke(payload(), { QWEN_HARNESS_WORKTREE: '' }).status).toBe(2);
});

it('permits legitimate workflow children without granting automatic approval', () => {
  const result = invoke(recordedChild().input);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
  expect(invoke({ ...payload(), agent_id: 'general-agent-0123456789abcdef' }).status).toBe(2);
});

it.each(['harness-researcher', 'harness-verifier', 'harness-reviewer'])('denies mutation for recorded %s even when the agent definition allows shell', (role) => {
  expect(invoke({ ...recordedChild(role).input, tool_name: 'run_shell_command' }).status).toBe(2);
});

it('fails closed on missing, malformed, oversized or mismatched transcript identity', () => {
  expect(invoke({ ...payload(), agent_id: 'workflow-agent-0123456789abcdef' }).status).toBe(2);
  const child = recordedChild();
  for (const content of ['{\n', `${'x'.repeat(1024 * 1024)}\n`, `${JSON.stringify({ ...child.header, sessionId: 'other' })}\n`, `${JSON.stringify({ ...child.header, agentId: 'other' })}\n`, `${JSON.stringify({ ...child.header, cwd: makeTmp('other-cwd') })}\n`]) {
    writeFileSync(child.file, content);
    expect(invoke(child.input).status).toBe(2);
  }
});

it('checks deferred-tool targets and rejects unknown bridge shapes', () => {
  expect(invoke(payload('tool_call', { name: 'Bash', arguments: {} })).status).toBe(2);
  expect(invoke(payload('tool_call', { name: 'read_file', arguments: {} })).status).toBe(0);
  expect(invoke(payload('tool_call', { name: 'workflow', arguments: { scriptPath: workflow } })).status).toBe(0);
  expect(invoke(payload('tool_call', { tool_name: 'write_file', args: {} })).status).toBe(2);
  expect(invoke(payload('tool_call', { name: 'tool_call', arguments: {} })).status).toBe(2);
  expect(invoke(payload('tool_call', { name: 'unknown_mutator', arguments: {} })).status).toBe(2);
});

it.each(['enter_worktree', 'exit_worktree', 'record_artifact', 'unknown_mutator'])('rejects unclassified tool %s', (tool) => {
  expect(invoke(payload(tool)).status).toBe(2);
  expect(invoke({ ...payload(tool), agent_id: 'workflow-agent-0123456789abcdef' }).status).toBe(2);
});
