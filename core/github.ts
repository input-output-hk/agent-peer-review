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
      retry: { retries: 2 },
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
