import { mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, it } from 'vitest';
import { qwenWriterGuardEnvironment } from '../src/qwen/writer-guard.js';
import { makeTmp } from './helpers.js';

let options: { home: string; packageRoot: string; worktree: string; workflowPath: string };
let link: string;
beforeEach(() => {
  const home = makeTmp('guard-home');
  const packageRoot = makeTmp('guard-package');
  const worktree = makeTmp('guard-worktree');
  const workflowPath = path.join(worktree, 'workflow.js');
  options = { home, packageRoot, worktree, workflowPath };
  link = path.join(home, '.qwen/extensions/qwen-dev-harness/.qwen-extension-install.json');
  mkdirSync(path.dirname(link), { recursive: true });
  writeFileSync(link, JSON.stringify({ source: packageRoot, type: 'link', originSource: 'QwenCode', externalContent: false }));
  mkdirSync(path.join(packageRoot, 'hooks'));
  writeFileSync(path.join(packageRoot, 'qwen-extension.json'), JSON.stringify({ name: 'qwen-dev-harness' }));
  writeFileSync(path.join(packageRoot, 'hooks/hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/enforce-writer.mjs"', timeout: 5000 }] }] } }));
  writeFileSync(path.join(packageRoot, 'hooks/enforce-writer.mjs'), '// fixture hook');
  writeFileSync(workflowPath, '// fixture workflow');
});

it('returns only scoped guard environment for the matching installation', () => {
  expect(qwenWriterGuardEnvironment(options)).toEqual({ QWEN_HARNESS_WRITER_GUARD: '1', QWEN_HARNESS_WORKTREE: realpathSync(options.worktree), QWEN_HARNESS_WORKFLOW_PATH: options.workflowPath });
});

it('compares canonical package paths', () => {
  const alias = path.join(makeTmp('guard-alias'), 'package');
  symlinkSync(options.packageRoot, alias, 'dir');
  expect(qwenWriterGuardEnvironment({ ...options, packageRoot: alias }).QWEN_HARNESS_WRITER_GUARD).toBe('1');
});

it.each(['missing', 'stale', 'malformed'])('rejects %s links with recovery guidance', (kind) => {
  if (kind === 'missing') options.home = makeTmp('guard-no-link');
  if (kind === 'stale') writeFileSync(link, JSON.stringify({ type: 'link', source: makeTmp('guard-stale') }));
  if (kind === 'malformed') writeFileSync(link, '{');
  expect(() => qwenWriterGuardEnvironment(options)).toThrow(/extension linking enabled/);
});

it.each(['hooks/hooks.json', 'hooks/enforce-writer.mjs'])('rejects invalid or empty %s', (file) => {
  writeFileSync(path.join(options.packageRoot, file), '');
  expect(() => qwenWriterGuardEnvironment(options)).toThrow(/No implementation session/);
});

it('rejects an alternate manifest hook route', () => {
  writeFileSync(path.join(options.packageRoot, 'qwen-extension.json'), JSON.stringify({ name: 'qwen-dev-harness', hooks: 'elsewhere.json' }));
  expect(() => qwenWriterGuardEnvironment(options)).toThrow(/writer guard/);
});

it('rejects changed hook command or missing input paths', () => {
  expect(() => qwenWriterGuardEnvironment({ ...options, worktree: '/nonexistent/guard-fixture' })).toThrow(/writer guard/);
  writeFileSync(path.join(options.packageRoot, 'hooks/hooks.json'), JSON.stringify({ hooks: { PreToolUse: [] } }));
  expect(() => qwenWriterGuardEnvironment(options)).toThrow(/writer guard/);
});
