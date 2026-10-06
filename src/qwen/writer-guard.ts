import { readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_COMMAND = 'node "${CLAUDE_PLUGIN_ROOT}/hooks/enforce-writer.mjs"';

/** Structural preflight only. Runtime hook execution is verified separately. */
export function qwenWriterGuardEnvironment(options: {
  worktree: string;
  workflowPath: string;
  packageRoot?: string;
  home?: string;
}): NodeJS.ProcessEnv {
  const packageRoot = options.packageRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  try {
    const root = realpathSync(packageRoot);
    const installation = JSON.parse(readFileSync(path.join(options.home ?? os.homedir(), '.qwen', 'extensions', 'qwen-dev-harness', '.qwen-extension-install.json'), 'utf8'));
    if (installation?.type !== 'link' || typeof installation.source !== 'string' || !path.isAbsolute(installation.source) || realpathSync(installation.source) !== root) throw new Error('stale extension');
    const manifest = JSON.parse(readFileSync(path.join(root, 'qwen-extension.json'), 'utf8'));
    if (manifest?.name !== 'qwen-dev-harness' || (manifest.hooks !== undefined && manifest.hooks !== 'hooks/hooks.json')) throw new Error('unexpected extension configuration');
    const configPath = path.join(root, 'hooks', 'hooks.json');
    const scriptPath = path.join(root, 'hooks', 'enforce-writer.mjs');
    for (const file of [configPath, scriptPath]) {
      const relative = path.relative(root, realpathSync(file));
      if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative) || !statSync(file).isFile()) throw new Error('invalid hook file');
    }
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const entries = config?.hooks?.PreToolUse;
    if (!Array.isArray(entries) || !entries.some((entry) => entry?.matcher === '.*' && Array.isArray(entry.hooks) && entry.hooks.some((hook: Record<string, unknown>) => hook?.type === 'command' && hook.command === HOOK_COMMAND && hook.timeout === 5000 && hook.env === undefined && (hook.async === undefined || hook.async === false)))) throw new Error('missing writer hook');
    if (!readFileSync(scriptPath, 'utf8').trim()) throw new Error('empty writer hook');
    if (!path.isAbsolute(options.worktree) || !path.isAbsolute(options.workflowPath)) throw new Error('invalid workflow paths');
    const worktree = realpathSync(options.worktree);
    if (!statSync(worktree).isDirectory() || !statSync(options.workflowPath).isFile()) throw new Error('invalid workflow paths');
    return {
      QWEN_HARNESS_WRITER_GUARD: '1',
      QWEN_HARNESS_WORKTREE: worktree,
      QWEN_HARNESS_WORKFLOW_PATH: options.workflowPath,
    };
  } catch {
    throw new Error('Delivery writer guard is missing, stale, or unreadable. No implementation session was started. Re-run project setup/update with extension linking enabled using this installed fern-harness version, then resume delivery.');
  }
}
