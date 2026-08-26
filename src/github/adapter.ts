/**
 * GitHub adapter interface: everything the bot needs from a code-hosting
 * provider. Two implementations exist:
 *
 *   - MockGitHubAdapter (./mock.ts)   fully in-memory, used by tests + demo
 *   - OctokitAdapter    (./octokit.ts) real GitHub via the `octokit` package
 */
export interface IssueData {
  number: number;
  title: string;
  body: string;
  labels: string[];
  url?: string;
  author?: string;
}

export interface CreateIssueInput {
  title: string;
  body?: string;
  labels?: string[];
}

export interface PullRequestData {
  number: number;
  title: string;
  head: string;
  base: string;
  url?: string;
}

export interface CreatePullRequestInput {
  title: string;
  body?: string;
  head: string;
  base: string;
}

export interface MergeResult {
  merged: boolean;
  sha: string | null;
}

export interface GitHubAdapter {
  readonly name: string;
  listOpenIssues(): Promise<IssueData[]>;
  createIssue(input: CreateIssueInput): Promise<IssueData>;
  addIssueComment(issueNumber: number, body: string): Promise<void>;
  addIssueLabels(issueNumber: number, labels: string[]): Promise<void>;
  createBranch(branch: string, fromBranch?: string): Promise<void>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequestData>;
  mergePullRequest(prNumber: number): Promise<MergeResult>;
}
