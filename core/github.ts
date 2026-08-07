import { execFileSync } from "node:child_process";
import { Octokit } from "@octokit/rest";
import { throttling } from "@octokit/plugin-throttling";
import { retry } from "@octokit/plugin-retry";
import type { PullRequest, IssueComment, LabelSpec, Review, ReviewComment } from "./model.js";
import { TRIGGER } from "./labels.js";
import {
  ConditionalCache,
  conditionalRequest,
  type ConditionalRequestOptions,
  type ConditionalRequestFn,
  type ConditionalResponse,
} from "./octokit-cache.js";

// Shared types for the expedition gateway methods below (PR 3). Plain data, no behavior.
export interface Mergeability {
  state: "clean" | "dirty" | "behind" | "blocked" | "unstable" | "draft" | "unknown";
  mergeable: boolean | null;   // GitHub's tri-state
  draft: boolean;
  baseRef: string;
  headSha: string;
}
export interface CheckResult { name: string; status: "success" | "failure" | "pending" | "neutral" }
export interface BranchProtectionSummary {
  requiresPullRequestReviews: boolean;
  requiredApprovingReviewCount: number;   // 0 is meaningful: PR required, no approvals needed
  requiredChecks: string[];
  enforceAdmins: boolean;
  requiresConversationResolution: boolean;
}
export interface DetailedPullFile { filename: string; status: string; additions: number; deletions: number; patch?: string }

export interface GitHubGateway {
  getAuthenticatedLogin(): Promise<string>;
  getPullRequest(repo: string, pr: number): Promise<PullRequest>;
  listReviewRequests(repo: string, login: string): Promise<PullRequest[]>;
  findAgentPulls(repo: string, login: string): Promise<PullRequest[]>;
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
  // Expedition methods (PR 3): read/write surface the auto-merge safety gate (Task 2) and the
  // acting flows (PR 4) need. Dumb mappings only; no judgment lives here.
  getMergeability(repo: string, pr: number): Promise<Mergeability>;
  getChecks(repo: string, ref: string): Promise<CheckResult[]>;
  getBranchProtection(repo: string, branch: string): Promise<BranchProtectionSummary | "none" | "unknown">;
  mergePull(repo: string, pr: number, opts: { sha: string; method?: "merge" | "squash" | "rebase"; commitTitle?: string }): Promise<{ merged: boolean; sha: string | null; message: string; reason: "head-moved" | "not-mergeable" | null }>;
  updateBranch(repo: string, pr: number, expectedHeadSha?: string): Promise<"updated" | "conflict">;
  listPullFilesDetailed(repo: string, pr: number): Promise<DetailedPullFile[]>;
  removeLabel(repo: string, pr: number, label: string): Promise<void>;
  listRequestedReviewers(repo: string, pr: number): Promise<{ users: string[]; teams: string[] }>;
  addAssignees(repo: string, pr: number, assignees: string[]): Promise<void>;
  getActorType(login: string): Promise<"User" | "Bot" | "Organization" | "unknown">;
  listOpenSecurityAlertCount(repo: string): Promise<number | null>;
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

// GitHub's `mergeable_state` values, mapped to Mergeability["state"]. `has_hooks` is a GitHub
// Enterprise Server-only value meaning "mergeable, pending pre-receive hooks"; treated as clean
// since the PR itself is mergeable. Any other or future value maps to "unknown" rather than
// guessing at its meaning.
const KNOWN_MERGEABLE_STATES: readonly Mergeability["state"][] =
  ["clean", "dirty", "behind", "blocked", "unstable", "draft", "unknown"];
function mapMergeableState(raw: string): Mergeability["state"] {
  if (raw === "has_hooks") return "clean";
  return (KNOWN_MERGEABLE_STATES as readonly string[]).includes(raw) ? (raw as Mergeability["state"]) : "unknown";
}

// Check-run `conclusion` -> CheckResult["status"]. `conclusion` is null while the run is
// queued/in_progress, which maps to "pending". The Octokit response type does not include
// "stale" (a value GitHub can still report for an older check run); it is handled explicitly
// here alongside the other documented terminal, non-green conclusions.
function checkRunStatus(conclusion: string | null): CheckResult["status"] {
  if (conclusion === null) return "pending";
  switch (conclusion) {
    case "success": return "success";
    case "neutral":
    case "skipped": return "neutral";
    default: return "failure"; // failure, cancelled, timed_out, action_required, stale, or unrecognized
  }
}

// Commit-status `state` -> CheckResult["status"]. The Status API only reports
// success/pending/failure/error (no neutral); "error" folds into "failure" since both are
// terminal and non-green.
function commitStatusStatus(state: string): CheckResult["status"] {
  switch (state) {
    case "success": return "success";
    case "pending": return "pending";
    default: return "failure"; // failure, error, or unrecognized
  }
}

export class OctokitGateway implements GitHubGateway {
  private kit: Octokit;
  private cachedLogin?: string;
  private readonly cache = new ConditionalCache();

  // `fetch` is an optional injection seam for tests only: it drives the
  // throttling/retry/conditional-cache stack over a fake transport instead of
  // the network. It is not part of the GitHubGateway interface.
  constructor(token = resolveToken(), fetch?: typeof globalThis.fetch) {
    const ThrottledOctokit = Octokit.plugin(throttling, retry);
    this.kit = new ThrottledOctokit({
      auth: token,
      request: fetch ? { fetch } : undefined,
      // Retry after the delay GitHub asks for, but only a bounded number of
      // times so a hard limit surfaces instead of looping forever. Warnings go
      // to STDERR via octokit.log.warn (console.warn), never to STDOUT.
      throttle: {
        onRateLimit: (retryAfter, options, octokit, retryCount) => {
          octokit.log.warn(`GitHub primary rate limit on ${options.method} ${options.url}; retry ${retryCount + 1} in ${retryAfter}s`);
          return retryCount < 2;
        },
        onSecondaryRateLimit: (retryAfter, options, octokit, retryCount) => {
          octokit.log.warn(`GitHub secondary rate limit on ${options.method} ${options.url}; retry ${retryCount + 1} in ${retryAfter}s`);
          return retryCount < 2;
        },
      },
      // @octokit/plugin-retry's own default is doNotRetry: [400,401,403,404,410,422,451]. Passing
      // doNotRetry here REPLACES that list rather than extending it, so every status that must
      // not retry is spelled out below (the original seven, plus 405 and 409). 409 on
      // pulls.merge means the pinned `sha` is no longer the PR's head; retrying the identical
      // `sha` cannot succeed. 405 on pulls.merge means the PR is not mergeable; a retry that
      // happened to succeed inside the retry window would merge a state the safety gate never
      // evaluated. Adding 409 here also stops repos.getContent from retrying GitHub's 409 for an
      // empty repository instead of failing fast.
      retry: { retries: 2, doNotRetry: [400, 401, 403, 404, 405, 409, 410, 422, 451] },
    });
    this.wireConditionalCache();
  }

  // Wire the ETag conditional-request cache as the outermost `request` hook, so
  // it sees the final outcome of the retry/throttle stack. Repeated GETs of an
  // unchanged resource revalidate with `If-None-Match` and come back as 304s,
  // which GitHub does not charge against the rate limit. The passed `request`
  // is the composed inner chain (no `.endpoint`), so the fully-resolved URL is
  // taken from the top-level parser to key the cache.
  private wireConditionalCache(): void {
    this.kit.hook.wrap("request", async (request, options) => {
      const { method, url } = this.kit.request.endpoint.parse(options);
      // Key on method + fully-resolved URL only. This assumes a single
      // representation per URL: every caller requests a given URL the same way,
      // so `Accept`/media-type is left out. A future caller that fetched the
      // same URL two ways would need a representation discriminator folded in.
      const key = `${method} ${url}`;
      const call: ConditionalRequestFn = async (o) => {
        // The helper hands back a copy of options carrying any new
        // `If-None-Match` header. Inner Octokit hooks are bound to the original,
        // request-scoped `options` reference and ignore a fresh object passed to
        // `request`, so mirror the header change onto that shared object.
        if (o.headers && o.headers !== options.headers) {
          options.headers = { ...options.headers, ...o.headers } as typeof options.headers;
        }
        return (await request(options)) as unknown as ConditionalResponse;
      };
      const response = await conditionalRequest(this.cache, key, options as ConditionalRequestOptions, call);
      return response as unknown as Awaited<ReturnType<typeof request>>;
    });
  }

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
      createdAt: data.created_at, updatedAt: data.updated_at, mergedAt: data.merged_at ?? null,
    };
  }
  async listReviewRequests(repo: string, login: string): Promise<PullRequest[]> {
    const q = `repo:${repo} is:pr is:open label:${TRIGGER} review-requested:${login}`;
    const items = await this.kit.paginate(this.kit.search.issuesAndPullRequests, { q, per_page: 100 });
    return Promise.all(items.map((i) => this.getPullRequest(repo, i.number)));
  }
  // Discovery across all PR states (open/closed/merged), for the dashboard sync (Phase 1) to
  // enumerate every agent-reviewed PR, not just the currently-open ones listReviewRequests sees.
  // Note: the Search API has a ~30/min secondary rate limit and caps results at 1000 per query;
  // windowing and backoff for large repos is the sync layer's concern (Phase 1), not this method's.
  async findAgentPulls(repo: string, login: string): Promise<PullRequest[]> {
    const queries = [`repo:${repo} is:pr label:${TRIGGER}`, `repo:${repo} is:pr reviewed-by:${login}`];
    const nums = new Set<number>();
    for (const q of queries) {
      const items = await this.kit.paginate(this.kit.search.issuesAndPullRequests, { q, per_page: 100 });
      for (const i of items) nums.add(i.number);
    }
    return Promise.all([...nums].map((n) => this.getPullRequest(repo, n)));
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
    try {
      await this.kit.issues.deleteComment({ owner, repo: name, comment_id: commentId });
    } catch (e: any) { if (e.status === 404) return; throw e; } // already deleted
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

  // -- Expedition methods (PR 3) -----------------------------------------------------------
  async getMergeability(repo: string, pr: number): Promise<Mergeability> {
    const [owner, name] = split(repo);
    const { data } = await this.kit.pulls.get({ owner, repo: name, pull_number: pr });
    return {
      state: mapMergeableState(data.mergeable_state),
      mergeable: data.mergeable,
      draft: data.draft ?? false,
      baseRef: data.base.ref,
      headSha: data.head.sha,
    };
  }
  async getChecks(repo: string, ref: string): Promise<CheckResult[]> {
    const [owner, name] = split(repo);
    const [runs, statusResponse] = await Promise.all([
      // Relies on GitHub's default filter=latest (only the latest run per check name, not every
      // historical run for this ref). That default is load-bearing for this method's contract:
      // "current state of each check", not a full history.
      this.kit.paginate(this.kit.checks.listForRef, { owner, repo: name, ref, per_page: 100 }),
      // Not run through kit.paginate: the combined-status body carries a top-level `url` key
      // alongside `total_count`, so octokit.paginate's search-shaped normalization (which
      // requires `total_count` WITHOUT a sibling `url`, see normalizePaginatedListResponse in
      // @octokit/plugin-paginate-rest) is skipped for it; a manual link-following loop would be
      // needed to paginate it. Out of scope for v1: a ref rarely has more than 100 distinct
      // status contexts.
      this.kit.repos.getCombinedStatusForRef({ owner, repo: name, ref, per_page: 100 }),
    ]);
    const fromRuns: CheckResult[] = runs.map((r) => ({ name: r.name, status: checkRunStatus(r.conclusion) }));
    const fromStatuses: CheckResult[] = statusResponse.data.statuses.map((s) => ({ name: s.context, status: commitStatusStatus(s.state) }));
    return [...fromRuns, ...fromStatuses];
  }
  async getBranchProtection(repo: string, branch: string): Promise<BranchProtectionSummary | "none" | "unknown"> {
    const [owner, name] = split(repo);
    try {
      const { data } = await this.kit.repos.getBranchProtection({ owner, repo: name, branch });
      return {
        requiresPullRequestReviews: data.required_pull_request_reviews != null,
        requiredApprovingReviewCount: data.required_pull_request_reviews?.required_approving_review_count ?? 0,
        // `contexts` is the older field; `checks` is the modern replacement (supports multiple
        // apps producing the same-named check). Fall back to deriving from `checks` so a branch
        // protected only via the modern field is not reported as requiring nothing.
        requiredChecks: data.required_status_checks?.contexts ?? data.required_status_checks?.checks?.map((c) => c.context) ?? [],
        enforceAdmins: data.enforce_admins?.enabled ?? false,
        requiresConversationResolution: data.required_conversation_resolution?.enabled ?? false,
      };
    } catch (e: any) {
      if (e.status === 404) return "none"; // branch has no protection configured
      // 403: the token lacks permission to read protection settings on this branch. The caller
      // cannot distinguish "protected but invisible to me" from "unprotected", so it must fail
      // closed rather than guess.
      if (e.status === 403) return "unknown";
      throw e;
    }
  }
  async mergePull(repo: string, pr: number, opts: { sha: string; method?: "merge" | "squash" | "rebase"; commitTitle?: string }): Promise<{ merged: boolean; sha: string | null; message: string; reason: "head-moved" | "not-mergeable" | null }> {
    const [owner, name] = split(repo);
    try {
      // `method` defaults to "merge" here only as a safety net; flows (PR 4) pass it explicitly
      // from config, so this default is never meant to encode a policy preference.
      const { data } = await this.kit.pulls.merge({
        owner, repo: name, pull_number: pr, sha: opts.sha, merge_method: opts.method ?? "merge",
        commit_title: opts.commitTitle,
      });
      return { merged: data.merged, sha: data.sha, message: data.message, reason: null };
    } catch (e: any) {
      // 405: the PR is not in a mergeable state. 409: `sha` no longer matches the PR's current
      // head (GitHub's own head-race guard). Both are expected "could not merge" outcomes, not
      // exceptional failures, so they return a value instead of throwing. `reason` lets callers
      // react differently (e.g. re-fetch and re-evaluate on a moved head vs. give up on 405).
      if (e.status === 409) return { merged: false, sha: null, message: e.message ?? "", reason: "head-moved" };
      if (e.status === 405) return { merged: false, sha: null, message: e.message ?? "", reason: "not-mergeable" };
      throw e;
    }
  }
  async updateBranch(repo: string, pr: number, expectedHeadSha?: string): Promise<"updated" | "conflict"> {
    const [owner, name] = split(repo);
    try {
      await this.kit.pulls.updateBranch({
        owner, repo: name, pull_number: pr,
        ...(expectedHeadSha ? { expected_head_sha: expectedHeadSha } : {}),
      });
      return "updated";
    } catch (e: any) {
      // 422 covers both an actual conflict updating the branch and an expected_head_sha
      // mismatch; GitHub does not distinguish the two with different status codes.
      if (e.status === 422) return "conflict";
      throw e;
    }
  }
  async listPullFilesDetailed(repo: string, pr: number): Promise<DetailedPullFile[]> {
    const [owner, name] = split(repo);
    const items = await this.kit.paginate(this.kit.pulls.listFiles, { owner, repo: name, pull_number: pr, per_page: 100 });
    return items.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch }));
  }
  async removeLabel(repo: string, pr: number, label: string): Promise<void> {
    const [owner, name] = split(repo);
    try {
      await this.kit.issues.removeLabel({ owner, repo: name, issue_number: pr, name: label });
    } catch (e: any) { if (e.status === 404) return; throw e; } // already absent
  }
  async listRequestedReviewers(repo: string, pr: number): Promise<{ users: string[]; teams: string[] }> {
    const [owner, name] = split(repo);
    const { data } = await this.kit.pulls.listRequestedReviewers({ owner, repo: name, pull_number: pr });
    return { users: (data.users ?? []).map((u) => u.login), teams: (data.teams ?? []).map((t) => t.slug) };
  }
  async addAssignees(repo: string, pr: number, assignees: string[]): Promise<void> {
    const [owner, name] = split(repo);
    await this.kit.issues.addAssignees({ owner, repo: name, issue_number: pr, assignees });
  }
  async getActorType(login: string): Promise<"User" | "Bot" | "Organization" | "unknown"> {
    try {
      const { data } = await this.kit.users.getByUsername({ username: login });
      switch (data.type) {
        case "User": return "User";
        case "Bot": return "Bot";
        case "Organization": return "Organization";
        default: return "unknown";
      }
    } catch (e: any) {
      if (e.status === 404) return "unknown";
      throw e;
    }
  }
  async listOpenSecurityAlertCount(repo: string): Promise<number | null> {
    const [owner, name] = split(repo);
    try {
      const items = await this.kit.paginate(this.kit.dependabot.listAlertsForRepo, { owner, repo: name, state: "open", per_page: 100 });
      return items.length;
    } catch (e: any) {
      // 403/404: Dependabot alerts are disabled or the token lacks access. 451: repository
      // access is blocked (e.g. a legal takedown). Callers must treat null as fail-closed for
      // any auto-merge decision: "we don't know" is never the same as "safe".
      if (e.status === 403 || e.status === 404 || e.status === 451) return null;
      throw e;
    }
  }
}
