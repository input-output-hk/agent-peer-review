// The taskflows' own tick sequences, driven through the REGISTERED pi tools rather than the core
// operations directly.
//
// core's own integration tests (test/integration/) prove the protocol. What can only be proven here
// is the adapter: the tools have to carry a multi-tick sequence without losing state, serialize each
// operation's result faithfully enough for a model to branch on it, and keep autonomy where it
// belongs. A tool that quietly dropped a result field, or read autonomy from anywhere but its own
// parameters, would pass every core test and break every flow.
//
// The gateway below is rebuilt locally rather than imported from core's test fakes, matching
// extension.test.ts: this package's tests exercise only its own public dependency,
// @input-output-hk/agent-review.
//
// Timestamps are the one thing not asserted here: the tools read the clock themselves
// (`new Date().toISOString()`), so the marker's `at` field is deliberately left alone.

import { describe, it, expect } from "vitest";
import { findActionMarkers } from "@input-output-hk/agent-review";
import { registerTools } from "./extension.js";

function fakePi() {
  const tools: any[] = [];
  return { tools, registerTool: (def: any) => tools.push(def) };
}

const REPO = "o/r";
const PR = 1;
const ME = "me";
const BOT = "dependabot[bot]";
const HEAD = "sha0001";
/** The head a base sync creates. A real pulls.updateBranch always produces a new merge commit. */
const SYNCED = "sha0002";

interface FakePull {
  number: number; title: string; author: string; headSha: string;
  baseSha: string; url: string; state: "open" | "closed" | "merged"; labels: string[];
}
interface FakeFile { filename: string; status: string; additions: number; deletions: number; patch?: string }
interface FakeComment { id: number; body: string; author: string }

const REVIEW_STATES = { APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED" } as const;

/**
 * A stateful stand-in for the GitHubGateway surface the five expedition tools read and write.
 *
 * Stateful on purpose: every scenario here is a sequence of ticks, and the whole question is what the
 * second tick sees of the first one's writes. `checksRead` records which ref the rails were gathered
 * for, so a tick that evaluated a stale commit cannot pass unnoticed.
 */
class FlowGateway {
  login = ME;
  mergeableState: "clean" | "behind" | "dirty" = "clean";
  comments: FakeComment[] = [];
  merges: Array<{ repo: string; pr: number; sha: string; method?: string }> = [];
  reviews: Array<{ id: number; author: string; state: string; event: string; body: string; commitId: string; submittedAt: string }> = [];
  updateBranchCalls: Array<{ expectedHeadSha?: string; from: string }> = [];
  checksRead: string[] = [];
  private nextCommentId = 1;
  private nextReviewId = 1;

  constructor(public pull: FakePull, public files: FakeFile[]) {}

  async getAuthenticatedLogin() { return this.login; }
  async getPullRequest() { return { ...this.pull, labels: [...this.pull.labels] }; }
  async getMergeability() {
    // A closed or merged pull request is never cleanly mergeable, whatever it was before.
    const state = this.pull.state === "open" ? this.mergeableState : "unknown";
    return { state, mergeable: state === "clean", draft: false, baseRef: "main", headSha: this.pull.headSha };
  }
  async listPullFilesDetailed() { return this.files.map((f) => ({ ...f })); }
  async getChecks(_repo: string, ref: string) {
    this.checksRead.push(ref);
    return [{ name: "build", status: "success" }];
  }
  async getBranchProtection() { return "none" as const; }
  async getReviews() { return this.reviews.map((r) => ({ ...r })); }
  async listRequestedReviewers() { return { users: [] as string[], teams: [] as string[] }; }
  async listOpenSecurityAlertCount() { return 0; }
  async getActorType(login: string) { return login.endsWith("[bot]") ? "Bot" as const : "User" as const; }
  async listComments() { return this.comments.map((c) => ({ ...c })); }
  async createComment(_repo: string, _pr: number, body: string) {
    const comment = { id: this.nextCommentId++, body, author: this.login };
    this.comments.push(comment);
    return { ...comment };
  }
  async deleteComment(_repo: string, id: number) {
    this.comments = this.comments.filter((c) => c.id !== id);
  }
  async submitReview(_repo: string, _pr: number, review: { commitId: string; event: keyof typeof REVIEW_STATES; body: string }) {
    const id = this.nextReviewId++;
    this.reviews.push({
      id, author: this.login, state: REVIEW_STATES[review.event], event: review.event,
      body: review.body, commitId: review.commitId, submittedAt: `t${id}`,
    });
    return { url: `https://example.com/review/${id}` };
  }
  async mergePull(repo: string, pr: number, opts: { sha: string; method?: string }) {
    if (this.pull.headSha !== opts.sha) return { merged: false, sha: null, message: "head sha mismatch", reason: "head-moved" as const };
    if (this.mergeableState !== "clean" || this.pull.state !== "open") {
      return { merged: false, sha: null, message: "not mergeable", reason: "not-mergeable" as const };
    }
    this.merges.push({ repo, pr, sha: opts.sha, method: opts.method });
    this.pull.state = "merged";
    return { merged: true, sha: `merge-${opts.sha}`, message: "merged", reason: null };
  }
  async updateBranch(_repo: string, _pr: number, expectedHeadSha?: string) {
    this.updateBranchCalls.push({ expectedHeadSha, from: this.pull.headSha });
    if (expectedHeadSha !== undefined && expectedHeadSha !== this.pull.headSha) return "conflict" as const;
    this.pull.headSha = SYNCED;
    this.mergeableState = "clean";
    return "updated" as const;
  }
}

const docsPull = (): FakePull => ({
  number: PR, title: "docs: fix a typo", author: "human-author", headSha: HEAD,
  baseSha: "base", url: "u", state: "open", labels: [],
});
const DOCS_FILES: FakeFile[] = [{ filename: "README.md", status: "modified", additions: 2, deletions: 1, patch: "@@\n-a\n+b" }];

const bumpPatch = (name: string, from: string, to: string): string =>
  ["@@ -12,7 +12,7 @@", '   "dependencies": {', `-    "${name}": "${from}",`, `+    "${name}": "${to}",`, '     "zod": "^3.23.0"'].join("\n");
const DEP_FILES: FakeFile[] = [
  { filename: "package.json", status: "modified", additions: 1, deletions: 1, patch: bumpPatch("left-pad", "^1.0.0", "^1.0.1") },
  { filename: "package-lock.json", status: "modified", additions: 12, deletions: 12, patch: "@@ -1 +1 @@\n-a\n+b" },
];
const depPull = (): FakePull => ({
  number: PR, title: "chore(deps): bump left-pad", author: BOT, headSha: HEAD,
  baseSha: "base", url: "u", state: "open", labels: [],
});

/** The ordinary config a flow runs under: no autonomy anywhere in it, because no tool reads one. */
const plainConfig = () => ({ githubLogin: ME, skillsDir: null, runChecks: false, reviewers: [], knownAgentLogins: [] });

function register(gh: FlowGateway, config: () => unknown) {
  const pi = fakePi();
  registerTools(pi as any, { gh: () => gh as any, config: config as any });
  return (name: string) => {
    const tool = pi.tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool named ${name}`);
    return (params: Record<string, unknown>) => tool.execute(`${name}-call`, params, undefined, undefined, undefined);
  };
}

/** The JSON payload a tool hands back to the model. */
const payload = (result: { content: Array<{ type: string; text: string }> }): any => {
  expect(result.content[0].type).toBe("text");
  return JSON.parse(result.content[0].text);
};

describe("taskflow sequences through the registered tools", () => {
  it("Flow A: syncs, proposes at the synced head, then recognizes its own proposal next tick", async () => {
    const gh = new FlowGateway(docsPull(), DOCS_FILES);
    gh.mergeableState = "behind";
    const tool = register(gh, plainConfig);

    // -- Tick 1, step 1: the branch is behind, so pr_stabilize syncs it.
    const synced = payload(await tool("pr_stabilize")({ repo: REPO, pr: PR }));
    expect(synced).toEqual({ status: "updated", detail: expect.stringContaining("main") });
    expect(gh.updateBranchCalls).toEqual([{ expectedHeadSha: HEAD, from: HEAD }]); // pinned, not blind
    expect(gh.pull.headSha).toBe(SYNCED);

    // -- Tick 1, step 2: pr_expedite evaluates the NEW head and, with no autonomy, proposes.
    const proposed = payload(await tool("pr_expedite")({ repo: REPO, pr: PR }));
    // Deep equality, field for field: this is the object a model branches on, so the adapter must
    // serialize the operation's result faithfully rather than a summary of it.
    expect(proposed).toEqual({ action: "proposed", reasons: ['autonomy is "propose", not "auto"'], headSha: SYNCED });
    expect(gh.checksRead).toContain(SYNCED); // the rails were gathered at the synced commit
    expect(gh.merges).toEqual([]);

    expect(gh.comments).toHaveLength(1);
    const markers = findActionMarkers(gh.comments);
    expect(markers).toHaveLength(1);
    expect(markers[0].marker).toMatchObject({ v: 1, kind: "expedite-proposal", headSha: SYNCED, decision: "propose" });
    expect(gh.comments[0].body).toContain("merge this pull request");

    // -- Tick 2: nothing has changed, so both steps are no-ops on the pull request.
    expect(payload(await tool("pr_stabilize")({ repo: REPO, pr: PR })).status).toBe("up-to-date");
    expect(gh.updateBranchCalls).toHaveLength(1); // and no second write to the branch

    const second = payload(await tool("pr_expedite")({ repo: REPO, pr: PR }));
    expect(second).toEqual({ action: "already-proposed", reasons: ['autonomy is "propose", not "auto"'], headSha: SYNCED });
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0].id).toBe(markers[0].comment.id); // the same comment, untouched
    expect(gh.merges).toEqual([]);
  });

  it("Flow C: proposes a bot version bump once, and approves and merges nothing", async () => {
    const gh = new FlowGateway(depPull(), DEP_FILES);
    const tool = register(gh, plainConfig);

    // -- Tick 1
    const proposed = payload(await tool("pr_approve_dep_upgrade")({ repo: REPO, pr: PR }));
    expect(proposed).toEqual({ action: "proposed", reasons: ['autonomy is "propose", not "auto"'] });
    expect(gh.reviews).toEqual([]);
    expect(gh.merges).toEqual([]);

    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0].body).toContain("approve and merge this patch dependency upgrade");
    expect(gh.comments[0].body).toContain("`left-pad`: ^1.0.0 -> ^1.0.1");
    const markers = findActionMarkers(gh.comments);
    expect(markers).toHaveLength(1);
    expect(markers[0].marker).toMatchObject({ v: 1, kind: "dep-upgrade-proposal", headSha: HEAD, decision: "propose" });

    // -- Tick 2: the same head, so nothing is posted again.
    expect(payload(await tool("pr_approve_dep_upgrade")({ repo: REPO, pr: PR })).action).toBe("already-proposed");
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0].id).toBe(markers[0].comment.id);
    expect(gh.reviews).toEqual([]);
    expect(gh.merges).toEqual([]);
  });

  it("ignores an autonomy smuggled into the config: only the tool parameter can ask for a merge", async () => {
    // A config file is not a place a repository can opt into auto-merge. These keys are exactly the
    // ones an over-helpful edit to config.json would add, and no tool reads any of them.
    const hostileConfig = () => ({
      ...plainConfig(),
      autonomy: "auto",
      mergeMethod: "squash",
      allowAutoMerge: true,
      expedite: { autonomy: "auto" },
    });

    const gh = new FlowGateway(docsPull(), DOCS_FILES); // clean, green, and otherwise mergeable
    const tool = register(gh, hostileConfig);

    const proposed = payload(await tool("pr_expedite")({ repo: REPO, pr: PR }));
    expect(proposed).toEqual({ action: "proposed", reasons: ['autonomy is "propose", not "auto"'], headSha: HEAD });
    expect(gh.merges).toEqual([]);
    expect(gh.comments).toHaveLength(1);

    const dep = new FlowGateway(depPull(), DEP_FILES);
    const depTool = register(dep, hostileConfig);
    expect(payload(await depTool("pr_approve_dep_upgrade")({ repo: REPO, pr: PR })).action).toBe("proposed");
    expect(dep.merges).toEqual([]);
    expect(dep.reviews).toEqual([]);

    // The positive control, on the very same state: an explicit parameter, and only that, merges. So
    // the two assertions above are about where autonomy comes from, not about an unmergeable pull
    // request.
    expect(payload(await tool("pr_expedite")({ repo: REPO, pr: PR, autonomy: "auto" })).action).toBe("merged");
    expect(gh.merges).toEqual([{ repo: REPO, pr: PR, sha: HEAD, method: "merge" }]);
  });
});
