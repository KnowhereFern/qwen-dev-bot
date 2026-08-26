import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach } from 'vitest';
import { Logger } from '../src/logger.js';

/** Logger that swallows everything, for quiet tests. */
export const silentLogger = new Logger({ sink: () => {} });

const tmpDirs: string[] = [];

/** Create a unique temp workDir inside the project (`.tmp/`), auto-removed. */
export function makeTmp(prefix: string): string {
  const base = path.join(process.cwd(), '.tmp');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, `${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
  }
});
