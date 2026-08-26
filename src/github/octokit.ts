import { Octokit } from 'octokit';
import type {
  CreateIssueInput,
  CreatePullRequestInput,
  GitHubAdapter,
  IssueData,
  MergeResult,
  PullRequestData,
} from './adapter.js';

export interface OctokitAdapterOptions {
  token?: string;
  /** "owner/name". */
  repo?: string;
}

/**
 * Real GitHub adapter built on the `octokit` package. Configuration comes
 * from env vars unless overridden:
 *
 *   GITHUB_TOKEN  personal access token / installation token
 *   GITHUB_REPO   "owner/name"
 *
 * NOTE: this path is reviewed, not exercised — no credentials were available
 * when this project was built, so it has not run against a live repository.
 */
export class OctokitAdapter implements GitHubAdapter {
  readonly name = 'octokit';

  private readonly octokit: Octokit;
  private readonly owner: string;
  private readonly repo: string;

  constructor(opts: OctokitAdapterOptions = {}) {
    const token = opts.token ?? process.env.GITHUB_TOKEN;
    const slug = opts.repo ?? process.env.GITHUB_REPO;
    if (!token) throw new Error('OctokitAdapter: GITHUB_TOKEN is required');
    if (!slug || !slug.includes('/')) {
      throw new Error('OctokitAdapter: GITHUB_REPO must be set to "owner/name"');
    }
    const [owner, repo] = slug.split('/');
    this.owner = owner as string;
    this.repo = repo as string;
    this.octokit = new Octokit({ auth: token });
  }

  async listOpenIssues(): Promise<IssueData[]> {
    const items = await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
      owner: this.owner,
      repo: this.repo,
      state: 'open',
      per_page: 100,
    });
    return items
      .filter((item) => !item.pull_request)
      .map((item) => ({
        number: item.number,
        title: item.title,
        body: item.body ?? '',
        labels: item.labels.map((label) => (typeof label === 'string' ? label : (label.name ?? ''))),
        url: item.html_url,
      }));
  }

  async createIssue(input: CreateIssueInput): Promise<IssueData> {
    const { data } = await this.octokit.rest.issues.create({
      owner: this.owner,
      repo: this.repo,
      title: input.title,
      body: input.body,
      labels: input.labels,
    });
    return {
      number: data.number,
      title: data.title,
      body: data.body ?? '',
      labels: input.labels ?? [],
      url: data.html_url,
    };
  }

  async addIssueComment(issueNumber: number, body: string): Promise<void> {
    await this.octokit.rest.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      body,
    });
  }

  async addIssueLabels(issueNumber: number, labels: string[]): Promise<void> {
    await this.octokit.rest.issues.addLabels({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      labels,
    });
  }

  async createBranch(branch: string, fromBranch: string = 'main'): Promise<void> {
    const { data: base } = await this.octokit.rest.repos.getBranch({
      owner: this.owner,
      repo: this.repo,
      branch: fromBranch,
    });
    await this.octokit.rest.git.createRef({
      owner: this.owner,
      repo: this.repo,
      ref: `refs/heads/${branch}`,
      sha: base.commit.sha,
    });
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestData> {
    const { data } = await this.octokit.rest.pulls.create({
      owner: this.owner,
      repo: this.repo,
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
    });
    return {
      number: data.number,
      title: data.title,
      head: input.head,
      base: input.base,
      url: data.html_url,
    };
  }

  async mergePullRequest(prNumber: number): Promise<MergeResult> {
    const { data } = await this.octokit.rest.pulls.merge({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      merge_method: 'squash',
    });
    return { merged: data.merged, sha: data.sha ?? null };
  }
}
