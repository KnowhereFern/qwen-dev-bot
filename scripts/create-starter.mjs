import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'starter-template');
const requested = process.argv[2] ?? path.join(root, 'qwen-harness-starter');
const target = path.resolve(requested);

if (target === root || target.startsWith(`${root}${path.sep}starter-template`)) {
  throw new Error('Choose a separate output directory; refusing to overwrite the harness source');
}
if (existsSync(target) && (!statSync(target).isDirectory() || readdirSync(target).length > 0)) {
  throw new Error(`Starter output must be an empty or absent directory: ${target}`);
}
mkdirSync(target, { recursive: true });
const safeTarget = realpathSync(target);
cpSync(source, safeTarget, { recursive: true, errorOnExist: true });
renameSync(path.join(safeTarget, 'gitignore.template'), path.join(safeTarget, '.gitignore'));
console.log(`Created delivery harness starter at ${safeTarget}`);
console.log(`Next: cd ${JSON.stringify(safeTarget)} && git init -b main`);
