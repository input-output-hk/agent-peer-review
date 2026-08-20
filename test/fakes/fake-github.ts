import type { GitHubGateway, Mergeability, CheckResult, BranchProtectionSummary, DetailedPullFile } from "../../core/github.js";
import type { PullRequest, IssueComment, LabelSpec, Review, ReviewComment } from "../../core/model.js";
import { TRIGGER } from "../../core/labels.js";

// seedPr's timestamp fields default to these fixed ISO strings so the many existing callers that
// predate PullRequest.createdAt/updatedAt/mergedAt keep compiling without passing them.
const DEFAULT_PR_TIMESTAMPS = { createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", mergedAt: null } as const;
type SeedPr = Omit<PullRequest, "createdAt" | "updatedAt" | "mergedAt"> & Partial<Pick<PullRequest, "createdAt" | "updatedAt" | "mergedAt">>;

// Fixed, deterministic stand-in for "now" when mergePull marks a PR merged. Never Date.now().
const FAKE_MERGED_AT = "2026-01-01T00:00:00Z";

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
  // Expedition state (PR 3): settable per-PR/per-repo state for the gateway's read/write surface
  // added in this PR. Safe defaults below mean existing callers that never touch these keep
  // working unchanged; Task 2 arranges failing checks, dirty mergeability, etc. via the setters.
  mergeability = new Map<string, Mergeability>();
  checks = new Map<string, CheckResult[]>();
  protection = new Map<string, BranchProtectionSummary | "none" | "unknown">();
  detailedFiles = new Map<string, DetailedPullFile[]>();
  requestedReviewers = new Map<string, { users: string[]; teams: string[] }>();
  actorTypes = new Map<string, "User" | "Bot" | "Organization" | "unknown">();
  alertCount = new Map<string, number | null>();
  updateBranchResult: "updated" | "conflict" = "updated";
  merges: Array<{ repo: string; pr: number; sha: string; method: "merge" | "squash" | "rebase"; commitTitle?: string }> = [];
  updateBranchCalls: Array<{ repo: string; pr: number; expectedHeadSha?: string; previousHeadSha?: string }> = [];
  removedLabels: Array<{ repo: string; pr: number; label: string }> = [];
  assigneesAdded: Array<{ repo: string; pr: number; assignees: string[] }> = [];
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
  // Stores a copy, not the caller's own object/array: the caller mutating what it passed in
  // after calling the setter must not silently corrupt this fake's stored state.
  setMergeability(repo: string, pr: number, m: Mergeability) { this.mergeability.set(this.key(repo, pr), { ...m }); }
  setChecks(repo: string, ref: string, checks: CheckResult[]) { this.checks.set(`${repo}@${ref}`, checks); }
  setBranchProtection(repo: string, branch: string, p: BranchProtectionSummary | "none" | "unknown") { this.protection.set(`${repo}@${branch}`, p); }
  setDetailedFiles(repo: string, pr: number, files: DetailedPullFile[]) { this.detailedFiles.set(this.key(repo, pr), files.map((f) => ({ ...f }))); }
  setRequestedReviewers(repo: string, pr: number, r: { users: string[]; teams: string[] }) { this.requestedReviewers.set(this.key(repo, pr), r); }
  setActorType(login: string, type: "User" | "Bot" | "Organization" | "unknown") { this.actorTypes.set(login, type); }
  setAlertCount(repo: string, count: number | null) { this.alertCount.set(repo, count); }
  setUpdateBranchResult(result: "updated" | "conflict") { this.updateBranchResult = result; }

  async getAuthenticatedLogin(): Promise<string> { return this.login; }
  async getPullRequest(repo: string, pr: number): Promise<PullRequest> {
    const found = this.prs.get(this.key(repo, pr));
    if (!found) throw new Error(`no PR ${repo}#${pr}`);
    return { ...found, labels: [...found.labels] };
  }
  async listReviewRequests(repo: string, login: string): Promise<PullRequest[]> {
    return [...this.prs.values()].filter((p) =>
      p.state === "open" && p.labels.includes(TRIGGER) && (this.requested.get(this.key(repo, p.number))?.has(login) ?? false));
  }
  async findAgentPulls(repo: string, login: string): Promise<PullRequest[]> {
    const prefix = `${repo}#`;
    const reviewedNumbers = new Set(this.reviews.filter((r) => r.repo === repo && r.author === login).map((r) => r.pr));
    return [...this.prs.entries()]
      .filter(([key, p]) => key.startsWith(prefix) && (p.labels.includes(TRIGGER) || reviewedNumbers.has(p.number)))
      .map(([, p]) => ({ ...p, labels: [...p.labels] }));
  }
  async requestReviewers(repo: string, pr: number, reviewers: string[]): Promise<void> {
    for (const r of reviewers) this.seedRequest(repo, pr, r);
    // `requested` (search-shaped, drives listReviewRequests) and `requestedReviewers` (the PR-3
    // listRequestedReviewers surface) are two views of the SAME GitHub concept, so a request has to
    // land in both. Keeping them in step is what lets an operation notice a reviewer it asked for
    // on an earlier tick.
    const current = this.requestedReviewers.get(this.key(repo, pr)) ?? { users: [], teams: [] };
    this.requestedReviewers.set(this.key(repo, pr), { users: [...new Set([...current.users, ...reviewers])], teams: [...current.teams] });
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
    // Native: submitting a review clears that reviewer's open request, in both views of it.
    this.requested.get(this.key(repo, pr))?.delete(this.login);
    const open = this.requestedReviewers.get(this.key(repo, pr));
    if (open) this.requestedReviewers.set(this.key(repo, pr), { users: open.users.filter((u) => u !== this.login), teams: [...open.teams] });
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

  // -- Expedition methods (PR 3) -----------------------------------------------------------
  /**
   * The mergeable state seeded with setMergeability, or "unknown" when a test never said.
   *
   * The default is deliberately a state that FAILS the gate. It used to be "clean", and that one
   * default hid a production deadlock through two review passes: a test could seed branch protection
   * requiring an approving review and still be handed a clean mergeable state, which is a combination
   * GitHub cannot produce (it reports "blocked" for a pull request awaiting its required review). The
   * tests asserted an impossible world and passed. A test that cares about the mergeable state now
   * has to say which one it means.
   */
  async getMergeability(repo: string, pr: number): Promise<Mergeability> {
    const key = this.key(repo, pr);
    const found = this.prs.get(key);
    if (found && found.state !== "open") {
      // A merged/closed PR is never cleanly mergeable, and this outranks whatever was seeded: a stale
      // "clean" left over from before the merge is exactly the kind of impossible state that must not
      // be reachable. There is no literal "closed" member of Mergeability["state"], so "unknown" is
      // the closest honest signal; mergeable: false makes the consequence unambiguous whichever field
      // a caller reads.
      return { state: "unknown", mergeable: false, draft: false, baseRef: "main", headSha: found.headSha };
    }
    const explicit = this.mergeability.get(key);
    if (explicit) return { ...explicit };
    return { state: "unknown", mergeable: null, draft: false, baseRef: "main", headSha: found?.headSha ?? "" };
  }
  async getChecks(repo: string, ref: string): Promise<CheckResult[]> {
    return (this.checks.get(`${repo}@${ref}`) ?? []).map((c) => ({ ...c }));
  }
  /**
   * The protection seeded with setBranchProtection, or "none" when a test never said.
   *
   * A summary comes back as a deep copy, and it carries every field of BranchProtectionSummary,
   * including `dismissesStaleReviews`: a test seeding protection has to state whether the branch
   * retires stale approvals, because that is what decides whether an approval of an older commit may
   * be counted (see ApprovalScope in core/expedition/protection.ts).
   */
  async getBranchProtection(repo: string, branch: string): Promise<BranchProtectionSummary | "none" | "unknown"> {
    const p = this.protection.get(`${repo}@${branch}`) ?? "none";
    return typeof p === "string" ? p : { ...p, requiredChecks: [...p.requiredChecks] };
  }
  async mergePull(repo: string, pr: number, opts: { sha: string; method?: "merge" | "squash" | "rebase"; commitTitle?: string }): Promise<{ merged: boolean; sha: string | null; message: string; reason: "head-moved" | "not-mergeable" | null }> {
    const key = this.key(repo, pr);
    const found = this.prs.get(key);
    if (!found) throw new Error(`no PR ${repo}#${pr}`);
    if (found.headSha !== opts.sha) {
      return { merged: false, sha: null, message: "head sha mismatch", reason: "head-moved" }; // mirrors GitHub's 409 guard
    }
    const mergeability = await this.getMergeability(repo, pr);
    if (mergeability.state !== "clean" || found.state !== "open") {
      return { merged: false, sha: null, message: "not mergeable", reason: "not-mergeable" }; // mirrors GitHub's 405
    }
    this.merges.push({ repo, pr, sha: opts.sha, method: opts.method ?? "merge", commitTitle: opts.commitTitle });
    const mergeSha = `merge-${opts.sha}`; // the merge commit's sha is distinct from the PR's own head sha
    found.state = "merged";
    found.mergedAt = FAKE_MERGED_AT;
    return { merged: true, sha: mergeSha, message: "merged", reason: null };
  }
  async updateBranch(repo: string, pr: number, expectedHeadSha?: string): Promise<"updated" | "conflict"> {
    const found = this.prs.get(this.key(repo, pr));
    this.updateBranchCalls.push({ repo, pr, expectedHeadSha, previousHeadSha: found?.headSha });
    if (this.updateBranchResult === "updated" && found) {
      found.headSha = `${found.headSha}-updated`; // real pulls.updateBranch always creates a new head commit
    }
    return this.updateBranchResult;
  }
  async listPullFilesDetailed(repo: string, pr: number): Promise<DetailedPullFile[]> {
    const key = this.key(repo, pr);
    const explicit = this.detailedFiles.get(key);
    if (explicit) return explicit.map((f) => ({ ...f }));
    // No explicit detailed files seeded: derive from the plain filename list so existing
    // seedPullFiles callers still get a usable (if minimal) detailed view.
    return (this.pullFiles.get(key) ?? []).map((filename) => ({ filename, status: "modified", additions: 1, deletions: 0, patch: undefined }));
  }
  async removeLabel(repo: string, pr: number, label: string): Promise<void> {
    const stored = this.prs.get(this.key(repo, pr));
    if (stored) stored.labels = stored.labels.filter((l) => l !== label); // no error if absent
    this.removedLabels.push({ repo, pr, label });
  }
  async listRequestedReviewers(repo: string, pr: number): Promise<{ users: string[]; teams: string[] }> {
    const r = this.requestedReviewers.get(this.key(repo, pr));
    return r ? { users: [...r.users], teams: [...r.teams] } : { users: [], teams: [] };
  }
  async addAssignees(repo: string, pr: number, assignees: string[]): Promise<void> {
    this.assigneesAdded.push({ repo, pr, assignees: [...assignees] });
  }
  async getActorType(login: string): Promise<"User" | "Bot" | "Organization" | "unknown"> {
    return this.actorTypes.get(login) ?? "User";
  }
  async listOpenSecurityAlertCount(repo: string): Promise<number | null> {
    const v = this.alertCount.get(repo);
    return v === undefined ? 0 : v;
  }
}
