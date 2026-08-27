import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { Logger } from '../src/logger.js';

/** Logger that swallows everything, for quiet tests. */
export const silentLogger = new Logger({ sink: () => {} });

const tmpDirs: string[] = [];

/** Create an isolated operating-system temp workDir, auto-removed with sibling state. */
export function makeTmp(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), `qwen-harness-${prefix}-`));
  const dir = path.join(root, 'work');
  mkdirSync(dir);
  tmpDirs.push(root);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
  }
});
