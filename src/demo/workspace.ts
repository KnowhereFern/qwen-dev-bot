import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { slugify, type MockScript } from '../agent/mock.js';

/**
 * Scaffolding for the mock target repository exercised by the demo and the
 * loop integration test. The target repo holds:
 *
 *   check.mjs     unit test gate: every features/*.mjs module must import
 *   postmerge.mjs post-merge checks: additionally rejects the regression
 *                 marker `.known-bug` and requires >= 1 feature
 *   features/     one ES module per implemented feature
 */

export const CHECK_SCRIPT = `import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const featuresDir = join(process.cwd(), 'features');
let files = [];
try {
  files = readdirSync(featuresDir).filter((f) => f.endsWith('.mjs'));
} catch {
  files = [];
}
for (const file of files) {
  await import(pathToFileURL(join(featuresDir, file)).href);
}
console.log(\`check: \${files.length} feature module(s) import cleanly\`);
`;

export const POSTMERGE_SCRIPT = `import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

if (existsSync(join(process.cwd(), '.known-bug'))) {
  console.error('post-merge: regression marker .known-bug is present on main');
  process.exit(1);
}
const featuresDir = join(process.cwd(), 'features');
let files = [];
try {
  files = readdirSync(featuresDir).filter((f) => f.endsWith('.mjs'));
} catch {
  files = [];
}
if (files.length === 0) {
  console.error('post-merge: expected at least one feature module');
  process.exit(1);
}
for (const file of files) {
  await import(pathToFileURL(join(featuresDir, file)).href);
}
console.log('post-merge: all checks passed');
`;

export function createWorkspace(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, 'features'), { recursive: true });
  writeFileSync(path.join(dir, 'check.mjs'), CHECK_SCRIPT, 'utf8');
  writeFileSync(path.join(dir, 'postmerge.mjs'), POSTMERGE_SCRIPT, 'utf8');
  writeFileSync(
    path.join(dir, 'README.md'),
    '# mock target repository\n\nMaterialized by the dev-bot demo/tests. Safe to delete.\n',
    'utf8',
  );
}

/**
 * Deterministic mock-agent scripts for the demo scenario:
 *
 *   feature     writes the feature module AND a `.known-bug` marker — the
 *               seeded regression the unit gate cannot see but post-merge
 *               checks catch
 *   self-repair removes the marker and records the fix in CHANGELOG.md
 */
export function createMockScripts(): Record<string, MockScript> {
  return {
    feature: (task) => [
      {
        op: 'write',
        path: `features/${slugify(task.issue.title)}.mjs`,
        content: `// feature: ${task.issue.title}\nexport const feature = ${JSON.stringify(task.issue.title)};\n`,
      },
      {
        op: 'write',
        path: '.known-bug',
        content: `seeded regression introduced while resolving issue #${task.issue.issueNumber}\n`,
      },
    ],
    'self-repair': (task) => [
      { op: 'delete', path: '.known-bug' },
      {
        op: 'write',
        path: 'CHANGELOG.md',
        content: `# Changelog\n\n- self-repair for issue #${task.issue.issueNumber}: removed the seeded regression marker.\n`,
      },
    ],
  };
}
