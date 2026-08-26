import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const config = JSON.parse(readFileSync('.qwen-harness/project.yml', 'utf8'));
const base = process.env.BASE_SHA;
const head = process.env.HEAD_SHA;
if (!base || !head) throw new Error('BASE_SHA and HEAD_SHA are required');
const result = spawnSync('git', ['diff', '--name-status', '-z', '--find-renames', `${base}..${head}`], {
  encoding: 'utf8',
  shell: false,
});
if (result.status !== 0) throw new Error(result.stderr);
const tokens = result.stdout.split('\0');
const files = new Set();
for (let index = 0; index < tokens.length;) {
  const status = tokens[index++];
  if (!status) continue;
  const first = tokens[index++];
  if (first) files.add(first);
  if (status.startsWith('R') || status.startsWith('C')) {
    const second = tokens[index++];
    if (second) files.add(second);
  }
}
const protectedFiles = [...files].filter(file => config.protectedPaths.some(item => item.endsWith('/') ? file.startsWith(item) : file === item || file.startsWith(item)));
if (protectedFiles.length === 0) {
  console.log('PASS no protected harness governance changes');
  process.exit(0);
}
const trusted = config.intake.trustedAuthors.includes(process.env.PR_AUTHOR || '');
if (!trusted) {
  console.error(`FAIL untrusted PR author changed protected paths: ${protectedFiles.join(', ')}`);
  process.exit(1);
}
console.log(`PASS trusted governance owner changed: ${protectedFiles.join(', ')}`);
