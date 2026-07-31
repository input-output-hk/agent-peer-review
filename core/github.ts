import { execFileSync } from "node:child_process";
import { Octokit } from "@octokit/rest";
import type { PullRequest, IssueComment, LabelSpec, Review, ReviewComment } from "./model.js";

export interface GitHubGateway {
  getAuthenticatedLogin(): Promise<string>;
  getPullRequest(repo: string, pr: number): Promise<PullRequest>;
  listReviewRequests(repo: string, login: string): Promise<PullRequest[]>;
  requestReviewers(repo: string, pr: number, reviewers: string[]): Promise<void>;
  addLabels(repo: string, pr: number, labels: string[]): Promise<void>;
  listLabels(repo: string): Promise<LabelSpec[]>;
  ensureLabel(repo: string, label: LabelSpec): Promise<"created" | "updated" | "unchanged">;
  listComments(repo: string, pr: number): Promise<IssueComment[]>;
  createComment(repo: string, pr: number, body: string): Promise<IssueComment>;
  deleteComment(repo: string, commentId: number): Promise<void>;
  submitReview(repo: string, pr: number, review: {
    commitId: string; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
    body: string; comments?: Array<{ path: string; line: number; body: string }>;
  }): Promise<{ url: string }>;
  getReviews(repo: string, pr: number): Promise<Review[]>;
  listReviewComments(repo: string, pr: number): Promise<ReviewComment[]>;
  listPullFiles(repo: string, pr: number): Promise<string[]>;
  getFileContent(repo: string, ref: string, path: string): Promise<string | null>;
  listDir(repo: string, ref: string, path: string): Promise<string[]>;
}

export function resolveToken(): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try { return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim(); }
  catch { throw new Error("No GitHub token: set GITHUB_TOKEN or run `gh auth login`."); }
}

const split = (repo: string): [string, string] => {
  const [owner, name] = repo.split("/");
  return [owner, name];
};

export class OctokitGateway implements GitHubGateway {
  private kit: Octokit;
  private cachedLogin?: string;
  constructor(token = resolveToken()) { this.kit = new Octokit({ auth: token }); }

  async getAuthenticatedLogin(): Promise<string> {
    if (!this.cachedLogin) this.cachedLogin = (await this.kit.users.getAuthenticated()).data.login;
    return this.cachedLogin;
  }
  async getPullRequest(repo: string, pr: number): Promise<PullRequest> {
    const [owner, name] = split(repo);
    const { data } = await this.kit.pulls.get({ owner, repo: name, pull_number: pr });
    return {
      number: data.number, title: data.title, author: data.user?.login ?? "unknown",
      headSha: data.head.sha, baseSha: data.base.sha, url: data.html_url,
      state: data.merged ? "merged" : (data.state as "open" | "closed"),
      labels: data.labels.map((l) => (typeof l === "string" ? l : l.name ?? "")),
    };
  }
  async listReviewRequests(repo: string, login: string): Promise<PullRequest[]> {
    const q = `repo:${repo} is:pr is:open label:agent review-requested:${login}`;
    const items = await this.kit.paginate(this.kit.search.issuesAndPullRequests, { q, per_page: 100 });
    return Promise.all(items.map((i) => this.getPullRequest(repo, i.number)));
  }
  async requestReviewers(repo: string, pr: number, reviewers: string[]): Promise<void> {
    const [owner, name] = split(repo);
    await this.kit.pulls.requestReviewers({ owner, repo: name, pull_number: pr, reviewers });
  }
  async addLabels(repo: string, pr: number, labels: string[]): Promise<void> {
    const [owner, name] = split(repo);
    await this.kit.issues.addLabels({ owner, repo: name, issue_number: pr, labels });
  }
  async listLabels(repo: string): Promise<LabelSpec[]> {
    const [owner, name] = split(repo);
    const items = await this.kit.paginate(this.kit.issues.listLabelsForRepo, { owner, repo: name, per_page: 100 });
    return items.map((l) => ({ name: l.name, color: l.color, description: l.description ?? "" }));
  }
  async ensureLabel(repo: string, label: LabelSpec): Promise<"created" | "updated" | "unchanged"> {
    const [owner, name] = split(repo);
    const existing = (await this.listLabels(repo)).find((l) => l.name === label.name);
    if (!existing) { await this.kit.issues.createLabel({ owner, repo: name, ...label }); return "created"; }
    if (existing.color !== label.color || existing.description !== label.description) {
      await this.kit.issues.updateLabel({ owner, repo: name, name: label.name, color: label.color, description: label.description });
      return "updated";
    }
    return "unchanged";
  }
  async listComments(repo: string, pr: number): Promise<IssueComment[]> {
    const [owner, name] = split(repo);
    const items = await this.kit.paginate(this.kit.issues.listComments, { owner, repo: name, issue_number: pr, per_page: 100 });
    return items.map((c) => ({ id: c.id, body: c.body ?? "", author: c.user?.login ?? "unknown" }));
  }
  async createComment(repo: string, pr: number, body: string): Promise<IssueComment> {
    const [owner, name] = split(repo);
    const { data } = await this.kit.issues.createComment({ owner, repo: name, issue_number: pr, body });
    return { id: data.id, body: data.body ?? "", author: data.user?.login ?? "unknown" };
  }
  async deleteComment(repo: string, commentId: number): Promise<void> {
    const [owner, name] = split(repo);
    await this.kit.issues.deleteComment({ owner, repo: name, comment_id: commentId });
  }
  async submitReview(repo: string, pr: number, review: { commitId: string; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body: string; comments?: Array<{ path: string; line: number; body: string }> }): Promise<{ url: string }> {
    const [owner, name] = split(repo);
    const { data } = await this.kit.pulls.createReview({
      owner, repo: name, pull_number: pr, commit_id: review.commitId, event: review.event, body: review.body,
      comments: review.comments?.map((c) => ({ path: c.path, line: c.line, body: c.body })),
    });
    return { url: data.html_url ?? `https://github.com/${repo}/pull/${pr}` };
  }
  async getReviews(repo: string, pr: number): Promise<Review[]> {
    const [owner, name] = split(repo);
    const items = await this.kit.paginate(this.kit.pulls.listReviews, { owner, repo: name, pull_number: pr, per_page: 100 });
    return items.map((r) => ({ id: r.id, author: r.user?.login ?? "unknown", state: r.state ?? "", body: r.body ?? "", commitId: r.commit_id ?? "", submittedAt: r.submitted_at ?? "" }));
  }
  async listReviewComments(repo: string, pr: number): Promise<ReviewComment[]> {
    const [owner, name] = split(repo);
    const items = await this.kit.paginate(this.kit.pulls.listReviewComments, { owner, repo: name, pull_number: pr, per_page: 100 });
    return items.map((c) => ({ id: c.id, path: c.path, line: c.line ?? null, body: c.body ?? "", author: c.user?.login ?? "unknown" }));
  }
  async listPullFiles(repo: string, pr: number): Promise<string[]> {
    const [owner, name] = split(repo);
    const items = await this.kit.paginate(this.kit.pulls.listFiles, { owner, repo: name, pull_number: pr, per_page: 100 });
    return items.map((f) => f.filename);
  }
  async getFileContent(repo: string, ref: string, path: string): Promise<string | null> {
    const [owner, name] = split(repo);
    try {
      const { data } = await this.kit.repos.getContent({ owner, repo: name, path, ref });
      if (!Array.isArray(data) && data.type === "file" && typeof data.content === "string" && data.encoding === "base64") {
        return Buffer.from(data.content, "base64").toString("utf8");
      }
      return null;
    } catch (e: any) { if (e.status === 404) return null; throw e; }
  }
  async listDir(repo: string, ref: string, path: string): Promise<string[]> {
    const [owner, name] = split(repo);
    try {
      const { data } = await this.kit.repos.getContent({ owner, repo: name, path, ref });
      return Array.isArray(data) ? data.map((d) => d.path) : [];
    } catch (e: any) { if (e.status === 404) return []; throw e; }
  }
}
