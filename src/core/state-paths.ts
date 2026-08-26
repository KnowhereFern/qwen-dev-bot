import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ProjectConfig } from './types.js';

export function harnessStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.QWEN_HARNESS_STATE_DIR) return path.resolve(env.QWEN_HARNESS_STATE_DIR);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'qwen-harness');
  if (process.platform === 'win32') {
    return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'qwen-harness');
  }
  return path.join(env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'qwen-harness');
}

export function projectIdFor(config: ProjectConfig): string {
  const identity = config.project.githubRepo || path.resolve(config.project.root);
  return `${config.project.name}-${createHash('sha256').update(identity).digest('hex').slice(0, 12)}`;
}

export function projectStateDir(config: ProjectConfig, stateRoot = harnessStateRoot()): string {
  return path.join(stateRoot, 'projects', projectIdFor(config));
}
