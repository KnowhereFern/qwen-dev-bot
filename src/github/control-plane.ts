import { Octokit } from 'octokit';
import { runProcess } from '../runtime/safe-process.js';

export const REQUIRED_GITHUB_CHECKS = [
  'Fern Delivery Harness / CI',
  'Fern Delivery Harness / governance',
  'Fern Delivery Harness / reward',
] as const;

export const REQUIRED_POST_MERGE_GITHUB_CHECKS = ['Fern Delivery Harness / CI'] as const;

export interface RemoteIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  author: string;
  url: string;
}

export interface RemotePullRequest {
  number: number;
  title: string;
  head: string;
  headSha: string;
  mergeCommitSha: string | null;
  base: string;
  url: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean | null;
}

export interface CheckSummary {
  complete: boolean;
  successful: boolean;
  pending: string[];
  failed: string[];
}

export interface GitHubControl {
  readonly repoSlug: string;
  currentUser(): Promise<string>;
  listOpenIssues(): Promise<RemoteIssue[]>;
  getIssue(issueNumber: number): Promise<RemoteIssue>;
  createIssue(input: { title: string; body: string; labels: string[] }): Promise<RemoteIssue>;
  updateIssue(issueNumber: number, input: { title?: string; body?: string }): Promise<RemoteIssue>;
  comment(issueNumber: number, body: string): Promise<void>;
  addLabels(issueNumber: number, labels: string[]): Promise<void>;
  removeLabel(issueNumber: number, label: string): Promise<void>;
  findPullRequestByHead(branch: string, expectedHeadSha?: string, expectedBase?: string): Promise<RemotePullRequest | null>;
  createPullRequest(input: { title: string; body: string; head: string; headSha: string; base: string }): Promise<RemotePullRequest>;
  getPullRequest(prNumber: number): Promise<RemotePullRequest>;
  checksForRef(sha: string, requiredNames: string[]): Promise<CheckSummary>;
  publishCheck(input: {
    name: string;
    sha: string;
    conclusion: 'success' | 'failure' | 'neutral';
    title: string;
    summary: string;
    text?: string;
    externalId?: string;
  }): Promise<void>;
  mergePullRequest(prNumber: number, expectedHeadSha: string): Promise<{ merged: boolean; sha: string | null; message: string }>;
}

export interface OctokitControlOptions {
  repo: string;
  token: string;
}

export class OctokitControlPlane implements GitHubControl {
  readonly repoSlug: string;
  private readonly owner: string;
  private readonly repo: string;
  private readonly octokit: Octokit;

  constructor(options: OctokitControlOptions) {
    const [owner, repo, extra] = options.repo.split('/');
    if (!owner || !repo || extra) throw new Error('GitHub repository must be owner/name');
    if (!options.token) throw new Error('GitHub token is required');
    this.owner = owner;
    this.repo = repo;
    this.repoSlug = options.repo;
    this.octokit = new Octokit({ auth: options.token });
  }

  async currentUser(): Promise<string> {
    const { data } = await this.octokit.rest.users.getAuthenticated();
    return data.login;
  }

  async listOpenIssues(): Promise<RemoteIssue[]> {
    const rows = await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
      owner: this.owner,
      repo: this.repo,
      state: 'open',
      per_page: 100,
    });
    return rows.filter((row) => !row.pull_request).map(toIssue);
  }

  async getIssue(issueNumber: number): Promise<RemoteIssue> {
    const { data } = await this.octokit.rest.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
    });
    return toIssue(data);
  }

  async createIssue(input: { title: string; body: string; labels: string[] }): Promise<RemoteIssue> {
    const { data } = await this.octokit.rest.issues.create({
      owner: this.owner,
      repo: this.repo,
      title: input.title,
      body: input.body,
      labels: input.labels,
    });
    return toIssue(data);
  }

  async updateIssue(issueNumber: number, input: { title?: string; body?: string }): Promise<RemoteIssue> {
    const { data } = await this.octokit.rest.issues.update({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      ...input,
    });
    return toIssue(data);
  }

  async comment(issueNumber: number, body: string): Promise<void> {
    await this.octokit.rest.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      body,
    });
  }

  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    await this.octokit.rest.issues.addLabels({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      labels,
    });
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    try {
      await this.octokit.rest.issues.removeLabel({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        name: label,
      });
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }
  }

  async findPullRequestByHead(branch: string, expectedHeadSha?: string, expectedBase?: string): Promise<RemotePullRequest | null> {
    const { data } = await this.octokit.rest.pulls.list({
      owner: this.owner,
      repo: this.repo,
      state: 'all',
      head: `${this.owner}:${branch}`,
      per_page: 10,
    });
    const candidates = data.map(toPullRequest).filter((candidate) => !expectedBase || candidate.base === expectedBase);
    return (
      candidates.find((candidate) => candidate.state === 'open') ??
      candidates.find((candidate) => candidate.merged && candidate.headSha === expectedHeadSha) ??
      null
    );
  }

  async createPullRequest(input: { title: string; body: string; head: string; headSha: string; base: string }): Promise<RemotePullRequest> {
    const existing = await this.findPullRequestByHead(input.head, input.headSha, input.base);
    if (existing) return existing;
    const { data } = await this.octokit.rest.pulls.create({
      owner: this.owner,
      repo: this.repo,
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
    });
    return toPullRequest(data);
  }

  async getPullRequest(prNumber: number): Promise<RemotePullRequest> {
    const { data } = await this.octokit.rest.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
    });
    return toPullRequest(data);
  }

  async checksForRef(sha: string, requiredNames: string[]): Promise<CheckSummary> {
    const [{ data: checks }, { data: statuses }] = await Promise.all([
      this.octokit.rest.checks.listForRef({ owner: this.owner, repo: this.repo, ref: sha, filter: 'latest', per_page: 100 }),
      this.octokit.rest.repos.getCombinedStatusForRef({ owner: this.owner, repo: this.repo, ref: sha, per_page: 100 }),
    ]);
    const states = new Map<string, string>();
    for (const check of checks.check_runs) {
      if (!states.has(check.name)) states.set(check.name, check.conclusion ?? check.status);
    }
    for (const status of statuses.statuses) {
      if (!states.has(status.context)) states.set(status.context, status.state);
    }
    const pending: string[] = [];
    const failed: string[] = [];
    for (const name of requiredNames) {
      const state = states.get(name);
      if (!state || ['queued', 'in_progress', 'pending'].includes(state)) pending.push(name);
      else if (!['success', 'neutral', 'skipped'].includes(state)) failed.push(name);
    }
    return { complete: pending.length === 0, successful: pending.length === 0 && failed.length === 0, pending, failed };
  }

  async publishCheck(input: {
    name: string;
    sha: string;
    conclusion: 'success' | 'failure' | 'neutral';
    title: string;
    summary: string;
    text?: string;
    externalId?: string;
  }): Promise<void> {
    await this.octokit.rest.repos.createCommitStatus({
      owner: this.owner,
      repo: this.repo,
      sha: input.sha,
      state: input.conclusion === 'failure' ? 'failure' : 'success',
      context: input.name,
      description: input.title.slice(0, 140),
    });
  }

  async mergePullRequest(
    prNumber: number,
    expectedHeadSha: string,
  ): Promise<{ merged: boolean; sha: string | null; message: string }> {
    const before = await this.getPullRequest(prNumber);
    if (before.headSha !== expectedHeadSha) {
      throw new Error(`PR #${prNumber} head changed from tested ${expectedHeadSha} to ${before.headSha}`);
    }
    const { data } = await this.octokit.rest.pulls.merge({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      sha: expectedHeadSha,
      merge_method: 'squash',
    });
    return { merged: data.merged, sha: data.sha ?? null, message: data.message };
  }
}

export async function resolveGitHubToken(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  if (token) return token;
  const receipt = await runProcess({ command: 'gh', args: ['auth', 'token'], cwd, timeoutMs: 10_000, env });
  if (receipt.exitCode !== 0 || !receipt.stdout.trim()) {
    throw new Error('GitHub authentication unavailable. Run `gh auth login` or set GH_TOKEN.');
  }
  return receipt.stdout.trim();
}

function toIssue(row: {
  number: number;
  title: string;
  body?: string | null;
  labels: Array<string | { name?: string | null }>;
  user?: { login?: string } | null;
  html_url: string;
}): RemoteIssue {
  return {
    number: row.number,
    title: row.title,
    body: row.body ?? '',
    labels: row.labels.map((label) => (typeof label === 'string' ? label : label.name ?? '')).filter(Boolean),
    author: row.user?.login ?? '',
    url: row.html_url,
  };
}

function toPullRequest(row: {
  number: number;
  title: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  html_url: string;
  state: string;
  merged?: boolean;
  merged_at?: string | null;
  mergeable?: boolean | null;
  merge_commit_sha?: string | null;
}): RemotePullRequest {
  return {
    number: row.number,
    title: row.title,
    head: row.head.ref,
    headSha: row.head.sha,
    mergeCommitSha: row.merge_commit_sha ?? null,
    base: row.base.ref,
    url: row.html_url,
    state: row.state === 'closed' ? 'closed' : 'open',
    merged: Boolean(row.merged || row.merged_at),
    mergeable: row.mergeable ?? null,
  };
}
