import type { GitHubGateway } from "../../core/github.js";
import type { PullRequest, IssueComment, LabelSpec, Review, ReviewComment } from "../../core/model.js";

// seedPr's timestamp fields default to these fixed ISO strings so the many existing callers that
// predate PullRequest.createdAt/updatedAt/mergedAt keep compiling without passing them.
const DEFAULT_PR_TIMESTAMPS = { createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", mergedAt: null } as const;
type SeedPr = Omit<PullRequest, "createdAt" | "updatedAt" | "mergedAt"> & Partial<Pick<PullRequest, "createdAt" | "updatedAt" | "mergedAt">>;

export class FakeGitHubGateway implements GitHubGateway {
  login = "me";
  prs = new Map<string, PullRequest>();
  comments = new Map<string, IssueComment[]>();
  requested = new Map<string, Set<string>>();
  labels = new Map<string, LabelSpec[]>();
  reviews: Array<{ repo: string; pr: number; id: number; author: string; state: string; event: string; body: string; commitId: string; comments?: Array<{ path: string; line: number; body: string }>; submittedAt: string }> = [];
  reviewComments: Array<{ repo: string; pr: number; id: number; path: string; line: number | null; body: string; author: string }> = [];
  pullFiles = new Map<string, string[]>();
  fileContents = new Map<string, string>();
  dirs = new Map<string, string[]>();
  private commentId = 1;
  private reviewSeq = 1;
  private reviewCommentSeq = 1;
  private key(repo: string, pr: number) { return `${repo}#${pr}`; }

  seedPr(pr: SeedPr, repo = "o/r") { this.prs.set(this.key(repo, pr.number), { ...DEFAULT_PR_TIMESTAMPS, ...pr }); }
  seedRequest(repo: string, pr: number, login: string) {
    const s = this.requested.get(this.key(repo, pr)) ?? new Set();
    s.add(login); this.requested.set(this.key(repo, pr), s);
  }
  seedPullFiles(repo: string, pr: number, paths: string[]) { this.pullFiles.set(`${repo}#${pr}`, paths); }
  seedFile(repo: string, ref: string, path: string, content: string) { this.fileContents.set(`${repo}@${ref}:${path}`, content); }
  seedDir(repo: string, ref: string, path: string, paths: string[]) { this.dirs.set(`${repo}@${ref}:${path}`, paths); }

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
  async findAgentPulls(repo: string, login: string): Promise<PullRequest[]> {
    const prefix = `${repo}#`;
    const reviewedNumbers = new Set(this.reviews.filter((r) => r.repo === repo && r.author === login).map((r) => r.pr));
    return [...this.prs.entries()]
      .filter(([key, p]) => key.startsWith(prefix) && (p.labels.includes("agent") || reviewedNumbers.has(p.number)))
      .map(([, p]) => ({ ...p, labels: [...p.labels] }));
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
    const id = this.reviewSeq++;
    const stateMap = { APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED" } as const;
    this.reviews.push({ repo, pr, id, author: this.login, state: stateMap[review.event], event: review.event, body: review.body, commitId: review.commitId, comments: review.comments, submittedAt: `t${id}` });
    for (const c of review.comments ?? []) this.reviewComments.push({ repo, pr, id: this.reviewCommentSeq++, path: c.path, line: c.line, body: c.body, author: this.login });
    this.requested.get(this.key(repo, pr))?.delete(this.login); // native: submitting clears the request
    return { url: `https://github.com/${repo}/pull/${pr}#pullrequestreview-${id}` };
  }
  async getReviews(repo: string, pr: number): Promise<Review[]> {
    return this.reviews.filter((r) => r.repo === repo && r.pr === pr)
      .map((r) => ({ id: r.id, author: r.author, state: r.state, body: r.body, commitId: r.commitId, submittedAt: r.submittedAt }));
  }
  async listReviewComments(repo: string, pr: number): Promise<ReviewComment[]> {
    return this.reviewComments.filter((c) => c.repo === repo && c.pr === pr)
      .map((c) => ({ id: c.id, path: c.path, line: c.line, body: c.body, author: c.author }));
  }
  async listPullFiles(repo: string, pr: number): Promise<string[]> { return this.pullFiles.get(`${repo}#${pr}`) ?? []; }
  async getFileContent(repo: string, ref: string, path: string): Promise<string | null> { return this.fileContents.get(`${repo}@${ref}:${path}`) ?? null; }
  async listDir(repo: string, ref: string, path: string): Promise<string[]> { return this.dirs.get(`${repo}@${ref}:${path}`) ?? []; }
}
