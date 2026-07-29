import type { GitHubGateway } from "../../core/github.js";
import type { PullRequest, IssueComment, LabelSpec } from "../../core/model.js";

export class FakeGitHubGateway implements GitHubGateway {
  login = "me";
  prs = new Map<string, PullRequest>();
  comments = new Map<string, IssueComment[]>();
  requested = new Map<string, Set<string>>();
  labels = new Map<string, LabelSpec[]>();
  reviews: Array<{ repo: string; pr: number; commitId: string; event: string; body: string; comments?: Array<{ path: string; line: number; body: string }> }> = [];
  private commentId = 1;
  private key(repo: string, pr: number) { return `${repo}#${pr}`; }

  seedPr(pr: PullRequest, repo = "o/r") { this.prs.set(this.key(repo, pr.number), { ...pr }); }
  seedRequest(repo: string, pr: number, login: string) {
    const s = this.requested.get(this.key(repo, pr)) ?? new Set();
    s.add(login); this.requested.set(this.key(repo, pr), s);
  }

  async getAuthenticatedLogin(): Promise<string> { return this.login; }
  async getPullRequest(repo: string, pr: number): Promise<PullRequest> {
    const found = this.prs.get(this.key(repo, pr));
    if (!found) throw new Error(`no PR ${repo}#${pr}`);
    return { ...found, labels: [...found.labels] };
  }
  async listReviewRequests(repo: string, login: string): Promise<PullRequest[]> {
    return [...this.prs.values()].filter((p) =>
      p.state === "open" && p.labels.includes("agent") && (this.requested.get(this.key(repo, p.number))?.has(login) ?? false));
  }
  async requestReviewers(repo: string, pr: number, reviewers: string[]): Promise<void> {
    for (const r of reviewers) this.seedRequest(repo, pr, r);
  }
  async addLabels(repo: string, pr: number, labels: string[]): Promise<void> {
    const stored = this.prs.get(this.key(repo, pr))!;
    stored.labels = [...new Set([...stored.labels, ...labels])];
  }
  async listLabels(repo: string): Promise<LabelSpec[]> { return this.labels.get(repo) ?? []; }
  async ensureLabel(repo: string, label: LabelSpec): Promise<"created" | "updated" | "unchanged"> {
    const list = this.labels.get(repo) ?? [];
    const existing = list.find((l) => l.name === label.name);
    if (!existing) { this.labels.set(repo, [...list, label]); return "created"; }
    if (existing.color !== label.color || existing.description !== label.description) { Object.assign(existing, label); return "updated"; }
    return "unchanged";
  }
  async listComments(repo: string, pr: number): Promise<IssueComment[]> { return this.comments.get(this.key(repo, pr)) ?? []; }
  async createComment(repo: string, pr: number, body: string): Promise<IssueComment> {
    const c = { id: this.commentId++, body, author: this.login };
    this.comments.set(this.key(repo, pr), [...(this.comments.get(this.key(repo, pr)) ?? []), c]);
    return c;
  }
  async deleteComment(repo: string, commentId: number): Promise<void> {
    for (const [k, list] of this.comments) this.comments.set(k, list.filter((c) => c.id !== commentId));
  }
  async submitReview(repo: string, pr: number, review: { commitId: string; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body: string; comments?: Array<{ path: string; line: number; body: string }> }): Promise<{ url: string }> {
    this.reviews.push({ repo, pr, commitId: review.commitId, event: review.event, body: review.body, comments: review.comments });
    this.requested.get(this.key(repo, pr))?.delete(this.login); // native: submitting clears the request
    return { url: `https://github.com/${repo}/pull/${pr}#pullrequestreview-1` };
  }
}
