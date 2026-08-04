import type { PullRequest, Review, ReviewComment, IssueComment } from "@input-output-hk/agent-review";
import type { SyncGateway } from "../sync-gateway.js";

interface Seeded { pull: PullRequest; reviews: Review[]; notes: ReviewComment[]; comments: IssueComment[]; }

/** In-memory SyncGateway for dashboard sync tests. Unlike the core fake, timestamps are caller-supplied ISO strings. */
export class FakeSyncGateway implements SyncGateway {
  login = "agent-bot";
  /** Number of times getAuthenticatedLogin() was called. Lets tests assert an explicit opts.login skips the auth call. */
  authCalls = 0;
  /** The `login` argument passed to each findAgentPulls() call, in call order. Lets tests assert which login sync() actually resolved and forwarded. */
  findAgentPullsLogins: string[] = [];
  private repos = new Map<string, Seeded[]>();

  seedPull(repo: string, s: { pull: PullRequest; reviews?: Review[]; notes?: ReviewComment[]; comments?: IssueComment[] }): void {
    const list = this.repos.get(repo) ?? [];
    list.push({ pull: s.pull, reviews: s.reviews ?? [], notes: s.notes ?? [], comments: s.comments ?? [] });
    this.repos.set(repo, list);
  }

  /** Replace a PR's children (models a subsequent sync where a review/note was deleted upstream). */
  setChildren(repo: string, number: number, c: { reviews?: Review[]; notes?: ReviewComment[]; comments?: IssueComment[] }): void {
    const found = (this.repos.get(repo) ?? []).find((x) => x.pull.number === number);
    if (!found) throw new Error(`no seeded PR ${repo}#${number}`);
    if (c.reviews) found.reviews = c.reviews;
    if (c.notes) found.notes = c.notes;
    if (c.comments) found.comments = c.comments;
  }

  async getAuthenticatedLogin(): Promise<string> { this.authCalls++; return this.login; }
  async findAgentPulls(repo: string, login: string): Promise<PullRequest[]> {
    this.findAgentPullsLogins.push(login);
    return (this.repos.get(repo) ?? []).map((x) => x.pull);
  }
  private find(repo: string, pr: number): Seeded | undefined { return (this.repos.get(repo) ?? []).find((x) => x.pull.number === pr); }
  async getReviews(repo: string, pr: number): Promise<Review[]> { return this.find(repo, pr)?.reviews ?? []; }
  async listReviewComments(repo: string, pr: number): Promise<ReviewComment[]> { return this.find(repo, pr)?.notes ?? []; }
  async listComments(repo: string, pr: number): Promise<IssueComment[]> { return this.find(repo, pr)?.comments ?? []; }
}
