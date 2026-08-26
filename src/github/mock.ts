import type {
  CreateIssueInput,
  CreatePullRequestInput,
  GitHubAdapter,
  IssueData,
  MergeResult,
  PullRequestData,
} from './adapter.js';

interface MockIssue extends IssueData {
  open: boolean;
}

interface MockPullRequest extends PullRequestData {
  body: string;
  merged: boolean;
  mergedAt: number | null;
}

/**
 * Fully in-memory GitHub adapter: issues, comments, labels, branches, PRs and
 * merge state. Unknown issue/PR numbers throw so wiring bugs surface loudly
 * in tests and the demo.
 */
export class MockGitHubAdapter implements GitHubAdapter {
  readonly name = 'mock';

  private issueSeq = 0;
  private prSeq = 0;

  readonly issues = new Map<number, MockIssue>();
  readonly comments = new Map<number, string[]>();
  readonly branches = new Map<string, string>();
  readonly pullRequests = new Map<number, MockPullRequest>();

  async listOpenIssues(): Promise<IssueData[]> {
    return [...this.issues.values()].filter((issue) => issue.open);
  }

  async createIssue(input: CreateIssueInput): Promise<IssueData> {
    this.issueSeq += 1;
    const issue: MockIssue = {
      number: this.issueSeq,
      title: input.title,
      body: input.body ?? '',
      labels: [...(input.labels ?? [])],
      url: `mock://issues/${this.issueSeq}`,
      open: true,
    };
    this.issues.set(issue.number, issue);
    return { ...issue };
  }

  async addIssueComment(issueNumber: number, body: string): Promise<void> {
    this.requireIssue(issueNumber);
    const list = this.comments.get(issueNumber) ?? [];
    list.push(body);
    this.comments.set(issueNumber, list);
  }

  async addIssueLabels(issueNumber: number, labels: string[]): Promise<void> {
    const issue = this.requireIssue(issueNumber);
    issue.labels = [...new Set([...issue.labels, ...labels])];
  }

  async createBranch(branch: string, fromBranch: string = 'main'): Promise<void> {
    if (this.branches.has(branch)) throw new Error(`Branch already exists: ${branch}`);
    this.branches.set(branch, fromBranch);
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestData> {
    if (!this.branches.has(input.head)) throw new Error(`Unknown head branch: ${input.head}`);
    this.prSeq += 1;
    const pr: MockPullRequest = {
      number: this.prSeq,
      title: input.title,
      body: input.body ?? '',
      head: input.head,
      base: input.base,
      url: `mock://pulls/${this.prSeq}`,
      merged: false,
      mergedAt: null,
    };
    this.pullRequests.set(pr.number, pr);
    const { body: _body, merged: _merged, mergedAt: _mergedAt, ...pub } = pr;
    return pub;
  }

  async mergePullRequest(prNumber: number): Promise<MergeResult> {
    const pr = this.pullRequests.get(prNumber);
    if (!pr) throw new Error(`Unknown pull request: ${prNumber}`);
    if (pr.merged) throw new Error(`Pull request #${prNumber} is already merged`);
    pr.merged = true;
    pr.mergedAt = Date.now();
    return { merged: true, sha: `mock-merge-sha-${prNumber}` };
  }

  private requireIssue(issueNumber: number): MockIssue {
    const issue = this.issues.get(issueNumber);
    if (!issue) throw new Error(`Unknown issue: ${issueNumber}`);
    return issue;
  }
}
