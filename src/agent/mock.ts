import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentExecutor, AgentResult, AgentTask, FileChange } from './executor.js';

/**
 * A deterministic script keyed by issue label. Given a task it returns the
 * exact file changes to apply, so tests and the demo are fully reproducible.
 */
export type MockScript = (task: AgentTask) => FileChange[] | Promise<FileChange[]>;

const defaultScript: MockScript = (task) => [
  {
    op: 'write',
    path: `issues/${slugify(task.issue.title)}.md`,
    content: `# ${task.issue.title}\n\n${task.issue.body}\n`,
  },
];

export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'issue';
}

/** Resolve `rel` inside `root`, refusing paths that escape the workDir. */
export function resolveInside(root: string, rel: string): string {
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, rel);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new Error(`Path escapes workDir: ${rel}`);
  }
  return abs;
}

/**
 * Deterministic executor. The first issue label that has a registered script
 * wins; otherwise the fallback script runs (default: drop a markdown note
 * under `issues/`). Changes are applied to the task's workDir.
 */
export class MockAgentExecutor implements AgentExecutor {
  readonly name = 'mock';

  constructor(
    private readonly scripts: Record<string, MockScript> = {},
    private readonly fallback: MockScript = defaultScript,
  ) {}

  async execute(task: AgentTask): Promise<AgentResult> {
    const label = task.issue.labels.find((l) => this.scripts[l] !== undefined);
    const script = label ? this.scripts[label] : this.fallback;
    if (!script) throw new Error(`MockAgentExecutor: no script for labels [${task.issue.labels.join(', ')}]`);
    const changes = await script(task);
    const changedFiles: string[] = [];
    for (const change of changes) {
      const abs = resolveInside(task.workDir, change.path);
      if (change.op === 'write') {
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, change.content ?? '', 'utf8');
      } else {
        await rm(abs, { force: true });
      }
      changedFiles.push(change.path);
    }
    return {
      summary: `mock agent applied ${changes.length} change(s)${label ? ` via script '${label}'` : ''}`,
      changedFiles,
    };
  }
}
