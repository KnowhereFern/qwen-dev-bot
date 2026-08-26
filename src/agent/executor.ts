import type { IssueRecord } from '../store.js';

/**
 * Teaching-fixture executor interface: turns an issue into deterministic file
 * changes inside the demo working copy. Production execution is Qwen-only and
 * lives in qwen/qwen-code-executor.ts.
 */
export interface AgentTask {
  issue: IssueRecord;
  /** Working copy of the target repository the change is applied to. */
  workDir: string;
  branch: string;
}

export interface FileChange {
  /** Path relative to the workDir. */
  path: string;
  op: 'write' | 'delete';
  content?: string;
}

export interface AgentResult {
  summary: string;
  changedFiles: string[];
}

export interface AgentExecutor {
  readonly name: string;
  execute(task: AgentTask): Promise<AgentResult>;
}
