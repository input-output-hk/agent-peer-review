import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  serializeMarker, PRIMARY_MARKER, DEFAULT_GATE_POLICY, DEPS_GATE_POLICY, DEFAULT_BOT_ALLOWLIST,
  DEFAULT_MAX_REVIEW_ROUNDS,
} from "@input-output-hk/agent-review";
import { registerTools, once } from "./extension.js";

function fakePi() {
  const tools: any[] = [];
  return { tools, registerTool: (def: any) => tools.push(def) };
}

// claimReview reads a "review" skill file off disk; give it an isolated temp dir
// rather than depending on this repo's real bundled skills/ contents.
function skillsDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "pi-ext-sk-"));
  writeFileSync(path.join(d, "review.md"), "# default review");
  return d;
}

const HEAD = "sha0001";

// A minimal fake covering exactly the GitHubGateway surface expedite reads for a green,
// docs-only, protection-free, alert-free pull request with no other reviewers: every rail
// clears except autonomy. Rebuilt locally (rather than importing core's test/fakes) so this
// package's tests exercise only its own public dependency, @input-output-hk/agent-review.
function fakeExpeditableGh(overrides: {
  author?: string;
  files?: Array<{ filename: string; status: string; additions: number; deletions: number; patch?: string }>;
} = {}) {
  const pr = {
    number: 1, title: "docs: fix a typo", author: overrides.author ?? "human-author",
    headSha: HEAD, baseSha: "base", url: "u", state: "open" as "open" | "closed" | "merged", labels: [] as string[],
  };
  const comments: Array<{ id: number; body: string; author: string }> = [];
  const merges: Array<{ repo: string; pr: number; sha: string; method?: string }> = [];
  let commentId = 1;
  return {
    comments, merges,
    async getAuthenticatedLogin() { return "me"; },
    async getPullRequest() { return { ...pr }; },
    async getMergeability() { return { state: "clean", mergeable: true, draft: false, baseRef: "main", headSha: pr.headSha }; },
    async listPullFilesDetailed() {
      return overrides.files ?? [{ filename: "README.md", status: "modified", additions: 2, deletions: 1, patch: "@@\n-a\n+b" }];
    },
    async getChecks() { return [{ name: "build", status: "success" }]; },
    async getBranchProtection() { return "none" as const; },
    async getReviews() { return []; },
    async listRequestedReviewers() { return { users: [], teams: [] }; },
    async listOpenSecurityAlertCount() { return 0; },
    async listComments() { return comments; },
    async createComment(_repo: string, _pr: number, body: string) {
      const c = { id: commentId++, body, author: "me" };
      comments.push(c);
      return c;
    },
    async deleteComment(_repo: string, id: number) {
      const i = comments.findIndex((c) => c.id === id);
      if (i >= 0) comments.splice(i, 1);
    },
    async mergePull(repo: string, prNum: number, opts: { sha: string; method?: string }) {
      merges.push({ repo, pr: prNum, sha: opts.sha, method: opts.method });
      pr.state = "merged";
      return { merged: true, sha: `merge-${opts.sha}`, message: "merged", reason: null };
    },
  };
}

const BOT = "dependabot[bot]";
const bumpPatch = (name: string, from: string, to: string): string =>
  ["@@ -12,7 +12,7 @@", '   "dependencies": {', `-    "${name}": "${from}",`, `+    "${name}": "${to}",`, '     "zod": "^3.23.0"'].join("\n");

// Mirrors core/operations/approve-dependency-upgrade.test.ts's seedBotBump fixture: a bot-authored,
// version-only patch bump (manifest + lockfile) that clears every rail except autonomy.
function fakeDepUpgradeGh() {
  const pr = {
    number: 2, title: "chore(deps): bump left-pad", author: BOT,
    headSha: HEAD, baseSha: "base", url: "u", state: "open" as "open" | "closed" | "merged", labels: [] as string[],
  };
  const comments: Array<{ id: number; body: string; author: string }> = [];
  const merges: Array<{ repo: string; pr: number; sha: string; method?: string }> = [];
  const reviews: Array<{ id: number; author: string; state: string; body: string; commitId: string; submittedAt: string }> = [];
  let commentId = 1;
  let reviewId = 1;
  return {
    comments, merges, reviews,
    async getAuthenticatedLogin() { return "me"; },
    async getPullRequest() { return { ...pr }; },
    async getActorType(login: string) { return login === BOT ? "Bot" as const : "User" as const; },
    async getMergeability() { return { state: "clean", mergeable: true, draft: false, baseRef: "main", headSha: pr.headSha }; },
    async listPullFilesDetailed() {
      return [
        { filename: "package.json", status: "modified", additions: 1, deletions: 1, patch: bumpPatch("left-pad", "^1.0.0", "^1.0.1") },
        { filename: "package-lock.json", status: "modified", additions: 12, deletions: 12, patch: "@@ -1 +1 @@\n-a\n+b" },
      ];
    },
    async getChecks() { return [{ name: "build", status: "success" }]; },
    async getBranchProtection() { return "none" as const; },
    async getReviews() { return reviews; },
    async listRequestedReviewers() { return { users: [], teams: [] }; },
    async listOpenSecurityAlertCount() { return 0; },
    async listComments() { return comments; },
    async createComment(_repo: string, _pr: number, body: string) {
      const c = { id: commentId++, body, author: "me" };
      comments.push(c);
      return c;
    },
    async deleteComment(_repo: string, id: number) {
      const i = comments.findIndex((c) => c.id === id);
      if (i >= 0) comments.splice(i, 1);
    },
    async submitReview(_repo: string, _pr: number, review: { commitId: string; event: string; body: string }) {
      const r = { id: reviewId++, author: "me", state: "APPROVED", body: review.body, commitId: review.commitId, submittedAt: `t${reviewId}` };
      reviews.push(r);
      return { url: "https://example.com/review/1" };
    },
    async mergePull(repo: string, prNum: number, opts: { sha: string; method?: string }) {
      merges.push({ repo, pr: prNum, sha: opts.sha, method: opts.method });
      pr.state = "merged";
      return { merged: true, sha: `merge-${opts.sha}`, message: "merged", reason: null };
    },
  };
}

describe("pi extension", () => {
  it("registers the review, self-review, follow-up, and expedition tools", () => {
    const pi = fakePi();
    registerTools(pi as any, { gh: () => ({}) as any, config: () => ({ githubLogin: "me", skillsDir: null }) as any });
    expect(pi.tools.map((t) => t.name).sort()).toEqual([
      "labels_bootstrap", "pr_approve_dep_upgrade", "pr_create_followup", "pr_expedite", "pr_request_review", "pr_self_review", "pr_stabilize", "pr_watch",
      "review_claim", "review_complete", "review_create", "review_enrich", "review_list",
    ]);
  });
  it("keeps Pi's convergence schemas aligned with the core and MCP adapters", () => {
    const pi = fakePi();
    registerTools(pi as any, { gh: () => ({}) as any, config: () => ({ githubLogin: "me", skillsDir: null }) as any });
    const byName = new Map(pi.tools.map((tool) => [tool.name, tool]));
    for (const name of ["review_complete", "review_enrich"] as const) {
      const properties = byName.get(name).parameters.properties;
      expect(properties).toHaveProperty("reviewedSha");
      expect(properties).toHaveProperty("mode");
      expect(properties).toHaveProperty("findings");
      expect(properties).toHaveProperty("workspace");
    }
    expect(byName.get("review_enrich").parameters.properties).toHaveProperty("assessments");
    expect(byName.get("pr_self_review").parameters.properties).toHaveProperty("whyReady");
    expect(byName.get("pr_create_followup").parameters.properties).toHaveProperty("acceptanceCriteria");
  });
  it("review_create falls back to config.reviewers when the call omits reviewers", async () => {
    const pi = fakePi();
    const calls: any = {};
    const gh = {
      getPullRequest: async () => ({ author: "a", headSha: "sha0001" }),
      getAuthenticatedLogin: async () => "me",
      listComments: async () => [],
      addLabels: async () => {},
      requestReviewers: async (_repo: string, _pr: number, reviewers: string[]) => { calls.reviewers = reviewers; },
    } as any;
    registerTools(pi as any, { gh: () => gh, config: () => ({ githubLogin: null, skillsDir: null, reviewers: ["patextreme"] }) as any });
    const create = pi.tools.find((t) => t.name === "review_create");
    const res = await create.execute("id-create-1", { repo: "o/r", pr: 7 }, undefined, undefined, undefined);
    expect(JSON.parse(res.content[0].text).reviewers).toEqual(["patextreme"]);
    expect(calls.reviewers).toEqual(["patextreme"]); // config default reached the gateway
  });
  it("review_create prefers an explicit reviewers list over the config default", async () => {
    const pi = fakePi();
    const calls: any = {};
    const gh = {
      getPullRequest: async () => ({ author: "a", headSha: "sha0001" }),
      getAuthenticatedLogin: async () => "me",
      listComments: async () => [],
      addLabels: async () => {},
      requestReviewers: async (_repo: string, _pr: number, reviewers: string[]) => { calls.reviewers = reviewers; },
    } as any;
    registerTools(pi as any, { gh: () => gh, config: () => ({ githubLogin: null, skillsDir: null, reviewers: ["patextreme"] }) as any });
    const create = pi.tools.find((t) => t.name === "review_create");
    const res = await create.execute("id-create-2", { repo: "o/r", pr: 7, reviewers: ["alice"] }, undefined, undefined, undefined);
    expect(JSON.parse(res.content[0].text).reviewers).toEqual(["alice"]);
    expect(calls.reviewers).toEqual(["alice"]); // explicit call wins over the config default
  });
  it("review_create throws a clear error when reviewers are empty everywhere", async () => {
    const pi = fakePi();
    registerTools(pi as any, { gh: () => ({}) as any, config: () => ({ githubLogin: null, skillsDir: null, reviewers: [] }) as any });
    const create = pi.tools.find((t) => t.name === "review_create");
    await expect(create.execute("id-create-3", { repo: "o/r", pr: 7 }, undefined, undefined, undefined))
      .rejects.toThrow(/no reviewers/i);
  });
  it("review_list wraps the core result in Pi content shape", async () => {
    const pi = fakePi();
    const gh = { getAuthenticatedLogin: async () => "me", listReviewRequests: async () => [], listComments: async () => [] } as any;
    registerTools(pi as any, { gh: () => gh, config: () => ({ githubLogin: null, skillsDir: null }) as any });
    const list = pi.tools.find((t) => t.name === "review_list");
    const res = await list.execute("id1", { repo: "o/r" }, undefined, undefined, undefined);
    expect(res.content[0].type).toBe("text");
    expect(JSON.parse(res.content[0].text)).toEqual([]);
  });
  it("review_claim wires params through claimReview and returns the Pi content shape", async () => {
    const pi = fakePi();
    const dir = skillsDir();
    // An existing marker authored by "me" so claimReview resumes rather than posting a new one
    // (createComment is deliberately not stubbed on this fake gateway).
    const marker = serializeMarker({ v: 1, reviewer: "me", machine: "m1", sha: "feed1234", claimedAt: "t0" });
    const gh = {
      getAuthenticatedLogin: async () => "me",
      listReviewRequests: async () => [],
      listComments: async () => [{ id: 1, author: "me", body: marker }],
      getPullRequest: async () => ({
        number: 7, title: "t", author: "a", headSha: "feed1234", baseSha: "base1",
        url: "https://example.com/o/r/pull/7", state: "open" as const, labels: ["ai-review"],
      }),
      listPullFiles: async () => [],
      getFileContent: async () => null,
      listDir: async () => [],
      getReviews: async () => [],
    } as any;
    registerTools(pi as any, { gh: () => gh, config: () => ({ githubLogin: null, skillsDir: dir }) as any });
    const claim = pi.tools.find((t) => t.name === "review_claim");
    const res = await claim.execute("id2", { repo: "o/r", pr: 7 }, undefined, undefined, undefined);
    expect(res.content[0].type).toBe("text");
    const task = JSON.parse(res.content[0].text);
    expect(task.headSha).toBe("feed1234");
    expect(task.reviewer).toBe("me");
    expect(task.role).toBe("anchor");
    expect(task.reviewContractVersion).toBe(1);
    expect(task.reviewHistory.mode).toBe("initial");
  });
  it("review_complete maps the event and reviews at the pinned SHA", async () => {
    const pi = fakePi();
    const marker = serializeMarker({ v: 1, reviewer: "me", machine: "m1", sha: "feed1234", claimedAt: "t0" });
    const calls: any = {};
    const gh = {
      getPullRequest: async () => ({
        number: 7, title: "t", author: "a", headSha: "feed1234", baseSha: "base1",
        url: "https://example.com/o/r/pull/7", state: "open" as const, labels: ["ai-review"],
      }),
      listComments: async () => [{ id: 9, author: "me", body: marker }],
      getReviews: async () => [], // completeReview now checks for a competing primary
      submitReview: async (_r: string, _p: number, opts: any) => { calls.submit = opts; return { url: "https://example.com/review/1" }; },
      deleteComment: async (_r: string, id: number) => { calls.deleted = id; },
    } as any;
    registerTools(pi as any, {
      gh: () => gh,
      config: () => ({ githubLogin: "me", skillsDir: null }) as any,
      workspaceState: () => ({ headSha: "feed1234", clean: true }),
    });
    const complete = pi.tools.find((t) => t.name === "review_complete");
    const res = await complete.execute("id3", { repo: "o/r", pr: 7, event: "approve", summary: "looks good" }, undefined, undefined, undefined);
    expect(res.content[0].type).toBe("text");
    expect(JSON.parse(res.content[0].text).url).toBe("https://example.com/review/1");
    expect(calls.submit.event).toBe("APPROVE");      // event enum mapped
    expect(calls.submit.commitId).toBe("feed1234");  // reviewed at the pinned SHA
    expect(calls.deleted).toBe(9);                   // claim marker cleared
  });
  it("review_enrich remaps the verdict and posts a COMMENT once a primary exists", async () => {
    const pi = fakePi();
    const marker = serializeMarker({ v: 1, reviewer: "me", machine: "m1", sha: "cafe1234", claimedAt: "t0" });
    const calls: any = {};
    const gh = {
      listComments: async () => [{ id: 5, author: "me", body: marker }],
      getReviews: async () => [{ id: 1, author: "alice", commitId: "cafe1234", submittedAt: "2026-01-01T00:00:00Z", body: `primary\n\n${PRIMARY_MARKER}` }],
      getPullRequest: async () => ({
        number: 7, title: "t", author: "a", headSha: "cafe1234", baseSha: "base1",
        url: "https://example.com/o/r/pull/7", state: "open" as const, labels: ["ai-review"],
      }),
      submitReview: async (_r: string, _p: number, opts: any) => { calls.submit = opts; return { url: "https://example.com/review/2" }; },
      deleteComment: async () => {},
    } as any;
    registerTools(pi as any, {
      gh: () => gh,
      config: () => ({ githubLogin: "me", skillsDir: null }) as any,
      workspaceState: () => ({ headSha: "cafe1234", clean: true }),
    });
    const enrich = pi.tools.find((t) => t.name === "review_enrich");
    const res = await enrich.execute("id4", { repo: "o/r", pr: 7, verdict: "agree", summary: "concur" }, undefined, undefined, undefined);
    expect(JSON.parse(res.content[0].text).status).toBe("enriched");
    expect(calls.submit.event).toBe("COMMENT");     // enricher posts a COMMENT review
    expect(calls.submit.commitId).toBe("cafe1234"); // at the primary review's commit
    expect(calls.submit.body).toContain("agree");   // p.verdict -> overallVerdict in the body
  });

  it("pr_stabilize reports updated when the branch is behind its base", async () => {
    const pi = fakePi();
    const gh = {
      getPullRequest: async () => ({ number: 1, title: "t", author: "a", headSha: HEAD, baseSha: "base", url: "u", state: "open" as const, labels: [] }),
      getMergeability: async () => ({ state: "behind" as const, mergeable: false, draft: false, baseRef: "main", headSha: HEAD }),
      updateBranch: async () => "updated" as const,
    } as any;
    registerTools(pi as any, { gh: () => gh, config: () => ({ githubLogin: "me", skillsDir: null }) as any });
    const stabilizeTool = pi.tools.find((t) => t.name === "pr_stabilize");
    const res = await stabilizeTool.execute("id-s1", { repo: "o/r", pr: 1 }, undefined, undefined, undefined);
    expect(JSON.parse(res.content[0].text).status).toBe("updated");
  });

  it('pr_expedite with no autonomy proposes and merges nothing (propose is the adapter-layer default)', async () => {
    const pi = fakePi();
    const gh = fakeExpeditableGh();
    registerTools(pi as any, { gh: () => gh, config: () => ({ githubLogin: "me", skillsDir: null, knownAgentLogins: [] }) as any });
    const expediteTool = pi.tools.find((t) => t.name === "pr_expedite");
    const res = await expediteTool.execute("id-e1", { repo: "o/r", pr: 1 }, undefined, undefined, undefined);
    expect(JSON.parse(res.content[0].text).action).toBe("proposed");
    expect(gh.merges).toEqual([]); // no autonomy given: never auto-merges
  });

  it('pr_expedite with an explicit autonomy: "auto" merges the same pull request', async () => {
    const pi = fakePi();
    const gh = fakeExpeditableGh();
    registerTools(pi as any, { gh: () => gh, config: () => ({ githubLogin: "me", skillsDir: null, knownAgentLogins: [] }) as any });
    const expediteTool = pi.tools.find((t) => t.name === "pr_expedite");
    const res = await expediteTool.execute("id-e2", { repo: "o/r", pr: 1, autonomy: "auto" }, undefined, undefined, undefined);
    expect(JSON.parse(res.content[0].text).action).toBe("merged");
    // The merge lands at the evaluated head, with the default method: nothing else is a valid merge here.
    expect(gh.merges).toEqual([{ repo: "o/r", pr: 1, sha: HEAD, method: "merge" }]);
  });

  it('pr_expedite passes an explicit mergeMethod "squash" through to the merge', async () => {
    const pi = fakePi();
    const gh = fakeExpeditableGh();
    registerTools(pi as any, { gh: () => gh, config: () => ({ githubLogin: "me", skillsDir: null, knownAgentLogins: [] }) as any });
    const expediteTool = pi.tools.find((t) => t.name === "pr_expedite");
    const res = await expediteTool.execute("id-e5", { repo: "o/r", pr: 1, autonomy: "auto", mergeMethod: "squash" }, undefined, undefined, undefined);
    expect(JSON.parse(res.content[0].text).action).toBe("merged");
    expect(gh.merges).toEqual([{ repo: "o/r", pr: 1, sha: HEAD, method: "squash" }]);
  });

  it("pr_expedite cannot widen the size rail past the default cap: a large maxLines still fails it", async () => {
    const pi = fakePi();
    // Single docs file, but well over the default max-lines cap regardless of what maxLines the
    // caller asks for.
    const gh = fakeExpeditableGh({
      files: [{ filename: "README.md", status: "modified", additions: DEFAULT_GATE_POLICY.maxLines + 100, deletions: 0, patch: "@@" }],
    });
    registerTools(pi as any, { gh: () => gh, config: () => ({ githubLogin: "me", skillsDir: null, knownAgentLogins: [] }) as any });
    const expediteTool = pi.tools.find((t) => t.name === "pr_expedite");
    const res = await expediteTool.execute("id-e6", { repo: "o/r", pr: 1, autonomy: "auto", maxLines: 999999 }, undefined, undefined, undefined);
    const result = JSON.parse(res.content[0].text);
    expect(result.action).toBe("proposed"); // the default cap still applies; 999999 cannot widen it
    expect(result.reasons.some((r: string) => r.includes("too many changed lines"))).toBe(true);
    expect(gh.merges).toEqual([]);
  });

  it("pr_request_review throws the same clear error as review_create when reviewers are empty everywhere", async () => {
    const pi = fakePi();
    registerTools(pi as any, { gh: () => ({}) as any, config: () => ({ githubLogin: "me", skillsDir: null, reviewers: [] }) as any });
    const requestReview = pi.tools.find((t) => t.name === "pr_request_review");
    await expect(requestReview.execute("id-r1", { repo: "o/r", pr: 7 }, undefined, undefined, undefined))
      .rejects.toThrow(/no reviewers/i);
  });

  it("pr_request_review falls back to config.reviewers when the call omits reviewers", async () => {
    const pi = fakePi();
    const calls: any = {};
    const gh = {
      getAuthenticatedLogin: async () => "me",
      getPullRequest: async () => ({ number: 7, title: "t", author: "a", headSha: HEAD, baseSha: "base", url: "u", state: "open" as const, labels: [] }),
      getActorType: async () => "User" as const, // a human author, so the bot-authored guard passes
      addLabels: async () => {},
      requestReviewers: async (_repo: string, _pr: number, reviewers: string[]) => { calls.reviewers = reviewers; },
    } as any;
    registerTools(pi as any, { gh: () => gh, config: () => ({ githubLogin: "me", skillsDir: null, reviewers: ["patextreme"] }) as any });
    const requestReview = pi.tools.find((t) => t.name === "pr_request_review");
    const res = await requestReview.execute("id-r2", { repo: "o/r", pr: 7 }, undefined, undefined, undefined);
    expect(JSON.parse(res.content[0].text).reviewers).toEqual(["patextreme"]);
    expect(calls.reviewers).toEqual(["patextreme"]); // config default reached the gateway
  });

  it("pr_approve_dep_upgrade reports not-eligible for a non-bot author", async () => {
    const pi = fakePi();
    const gh = {
      getAuthenticatedLogin: async () => "me",
      getPullRequest: async () => ({ number: 9, title: "t", author: "human-author", headSha: HEAD, baseSha: "base", url: "u", state: "open" as const, labels: [] }),
    } as any;
    registerTools(pi as any, { gh: () => gh, config: () => ({ githubLogin: "me", skillsDir: null, knownAgentLogins: [] }) as any });
    const approveDep = pi.tools.find((t) => t.name === "pr_approve_dep_upgrade");
    const res = await approveDep.execute("id-d1", { repo: "o/r", pr: 9 }, undefined, undefined, undefined);
    const result = JSON.parse(res.content[0].text);
    expect(result.action).toBe("not-eligible");
    expect(result.reasons[0]).toContain("not an allowlisted dependency bot");
  });

  it("pr_approve_dep_upgrade with no autonomy proposes a bot version bump and approves/merges nothing", async () => {
    const pi = fakePi();
    const gh = fakeDepUpgradeGh();
    registerTools(pi as any, { gh: () => gh, config: () => ({ githubLogin: "me", skillsDir: null, knownAgentLogins: [] }) as any });
    const approveDep = pi.tools.find((t) => t.name === "pr_approve_dep_upgrade");
    const res = await approveDep.execute("id-d2", { repo: "o/r", pr: 2 }, undefined, undefined, undefined);
    const result = JSON.parse(res.content[0].text);
    expect(result.action).toBe("proposed");
    expect(gh.merges).toEqual([]);
    expect(gh.reviews).toEqual([]);
  });

  it('pr_approve_dep_upgrade with an explicit autonomy: "auto" approves and merges the same bot bump', async () => {
    const pi = fakePi();
    const gh = fakeDepUpgradeGh();
    registerTools(pi as any, { gh: () => gh, config: () => ({ githubLogin: "me", skillsDir: null, knownAgentLogins: [] }) as any });
    const approveDep = pi.tools.find((t) => t.name === "pr_approve_dep_upgrade");
    const res = await approveDep.execute("id-d3", { repo: "o/r", pr: 2, autonomy: "auto" }, undefined, undefined, undefined);
    const result = JSON.parse(res.content[0].text);
    expect(result.action).toBe("approved-and-merged");
    expect(gh.merges).toEqual([{ repo: "o/r", pr: 2, sha: HEAD, method: "merge" }]);
    expect(gh.reviews).toHaveLength(1);
    expect(gh.reviews[0]).toMatchObject({ author: "me", state: "APPROVED", commitId: HEAD });
  });

  it("pr_request_review reports bot-authored and requests nothing for a dependency bot's pull request", async () => {
    const pi = fakePi();
    const calls: any = {};
    const author = DEFAULT_BOT_ALLOWLIST[1]; // renovate[bot], the REST login behind issue #48
    const gh = {
      getPullRequest: async () => ({ number: 7, title: "t", author, headSha: HEAD, baseSha: "base", url: "u", state: "open" as const, labels: [] }),
      getActorType: async () => "Bot" as const,
      addLabels: async () => { calls.labeled = true; },
      requestReviewers: async (_repo: string, _pr: number, reviewers: string[]) => { calls.reviewers = reviewers; },
    } as any;
    registerTools(pi as any, { gh: () => gh, config: () => ({ githubLogin: "me", skillsDir: null, reviewers: ["patextreme"] }) as any });
    const requestReview = pi.tools.find((t) => t.name === "pr_request_review");
    const res = await requestReview.execute("id-r3", { repo: "o/r", pr: 7 }, undefined, undefined, undefined);
    const result = JSON.parse(res.content[0].text);
    expect(result.status).toBe("bot-authored");
    expect(result.reason).toContain("steward");
    expect(calls.reviewers).toBeUndefined(); // nobody was asked
    expect(calls.labeled).toBeUndefined();   // nothing was labeled
  });

  it("pr_request_review still requests a review for a bot outside the dependency allowlist", async () => {
    const pi = fakePi();
    const calls: any = {};
    const gh = {
      getAuthenticatedLogin: async () => "me",
      getPullRequest: async () => ({ number: 8, title: "t", author: "github-actions[bot]", headSha: HEAD, baseSha: "base", url: "u", state: "open" as const, labels: [] }),
      getActorType: async () => "Bot" as const, // a bot, but not one the steward path can take
      addLabels: async () => { calls.labeled = true; },
      requestReviewers: async (_repo: string, _pr: number, reviewers: string[]) => { calls.reviewers = reviewers; },
    } as any;
    registerTools(pi as any, { gh: () => gh, config: () => ({ githubLogin: "me", skillsDir: null, reviewers: ["patextreme"] }) as any });
    const requestReview = pi.tools.find((t) => t.name === "pr_request_review");
    const res = await requestReview.execute("id-r4", { repo: "o/r", pr: 8 }, undefined, undefined, undefined);
    expect(JSON.parse(res.content[0].text).status).toBe("requested");
    expect(calls.reviewers).toEqual(["patextreme"]);
  });

  it("pr_approve_dep_upgrade cannot widen the size rail past the deps policy cap", async () => {
    const pi = fakePi();
    const gh = fakeDepUpgradeGh();
    registerTools(pi as any, { gh: () => gh, config: () => ({ githubLogin: "me", skillsDir: null, knownAgentLogins: [] }) as any });
    const approveDep = pi.tools.find((t) => t.name === "pr_approve_dep_upgrade");
    // The diff is 26 lines, so a clamped-down maxLines of 1 is what must bite: if 999999 had been
    // taken at face value the tool could widen its own blast radius in the call that asks to merge.
    const wide = await approveDep.execute("id-d4", { repo: "o/r", pr: 2, autonomy: "auto", maxLines: 999999 }, undefined, undefined, undefined);
    expect(JSON.parse(wide.content[0].text).action).toBe("approved-and-merged"); // 26 lines is inside the deps cap
    expect(JSON.parse(wide.content[0].text).reasons).toEqual([]);
    expect(gh.merges).toHaveLength(1);

    const tight = fakeDepUpgradeGh();
    const pi2 = fakePi();
    registerTools(pi2 as any, { gh: () => tight, config: () => ({ githubLogin: "me", skillsDir: null, knownAgentLogins: [] }) as any });
    const res = await pi2.tools.find((t) => t.name === "pr_approve_dep_upgrade")
      .execute("id-d5", { repo: "o/r", pr: 2, autonomy: "auto", maxLines: 1 }, undefined, undefined, undefined);
    const result = JSON.parse(res.content[0].text);
    expect(result.action).toBe("proposed"); // a caller may still tighten
    expect(result.reasons.some((r: string) => r.includes("too many changed lines"))).toBe(true);
    expect(tight.merges).toEqual([]);
  });

  it("pr_approve_dep_upgrade advertises the deps policy caps, not the general ones", () => {
    const pi = fakePi();
    registerTools(pi as any, { gh: () => ({}) as any, config: () => ({ githubLogin: "me", skillsDir: null }) as any });
    const approveDep = pi.tools.find((t) => t.name === "pr_approve_dep_upgrade");
    const params = approveDep.parameters.properties;
    expect(params.maxLines.description).toContain(String(DEPS_GATE_POLICY.maxLines));
    expect(params.maxFiles.description).toContain(String(DEPS_GATE_POLICY.maxFiles));
    expect(params.botAllowlist.items.description).toContain("Narrows");
    expect(DEPS_GATE_POLICY.maxLines).toBeGreaterThan(DEFAULT_GATE_POLICY.maxLines);
  });

  it("pr_watch resolves the acting login from the token when config has none, and returns a decision", async () => {
    const pi = fakePi();
    const gh = {
      getAuthenticatedLogin: async () => "me",
      getPullRequest: async () => ({ number: 3, title: "t", author: "human-author", headSha: HEAD, baseSha: "base", url: "u", state: "open" as const, labels: [] }),
      getReviews: async () => [{ id: 1, author: "me", state: "CHANGES_REQUESTED", body: "", commitId: HEAD, submittedAt: "t1" }],
    } as any;
    registerTools(pi as any, { gh: () => gh, config: () => ({ githubLogin: null, skillsDir: null, knownAgentLogins: [] }) as any });
    const watch = pi.tools.find((t) => t.name === "pr_watch");
    const res = await watch.execute("id-w1", { repo: "o/r", pr: 3 }, undefined, undefined, undefined);
    const result = JSON.parse(res.content[0].text);
    expect(result.action).toBe("wait"); // no push since "me" requested changes at the current head
  });

  it("pr_watch cannot widen the handoff cap past the built-in review-round limit", async () => {
    const pi = fakePi();
    const gh = {
      getPullRequest: async () => ({
        number: 3, title: "t", author: "human-author", headSha: "sha0004", baseSha: "base",
        url: "u", state: "open" as const, labels: [],
      }),
      getReviews: async () => [1, 2, 3].map((round) => ({
        id: round,
        author: "me",
        state: "CHANGES_REQUESTED",
        body: "",
        commitId: `sha000${round}`,
        submittedAt: `2026-08-01T00:00:0${round}Z`,
      })),
    } as any;
    registerTools(pi as any, {
      gh: () => gh,
      config: () => ({ githubLogin: "me", skillsDir: null, knownAgentLogins: [] }) as any,
    });
    const watch = pi.tools.find((t) => t.name === "pr_watch");
    expect(watch.parameters.properties.maxReviewRounds.maximum).toBe(DEFAULT_MAX_REVIEW_ROUNDS);

    // Runtime clamping remains the backstop even for a host that does not enforce TypeBox schemas.
    const response = await watch.execute(
      "id-w-cap",
      { repo: "o/r", pr: 3, maxReviewRounds: 999 },
      undefined,
      undefined,
      undefined,
    );
    expect(JSON.parse(response.content[0].text)).toMatchObject({ action: "hold-for-human" });
  });

  it("pr_watch's knownAgentLogins from config reaches the human-review rail", async () => {
    // "me" requested changes at an older head, the author pushed since, and "peer-bot" left a
    // CHANGES_REQUESTED review in between. Whether that standing verdict counts as a human's
    // depends entirely on whether config lists "peer-bot" as a known agent.
    //
    // A verdict, not a COMMENTED review: since issue #57 a comment is not a position on the change
    // and holds nothing, so a comment here would test the plumbing against a state that no longer
    // separates the two configs.
    //
    // getAuthenticatedLogin deliberately returns a login that is NEITHER "me" nor "peer-bot":
    // config.githubLogin ("me") must win over the token for myLogin resolution. If precedence
    // were inverted, myLogin would resolve to "someone-else", watchAndReReview would find no
    // review authored by "someone-else", and both assertions below (hold-for-human / re-review)
    // would fail with "none" instead.
    const gh = {
      getAuthenticatedLogin: async () => "someone-else",
      getPullRequest: async () => ({ number: 4, title: "t", author: "human-author", headSha: "sha0002", baseSha: "base", url: "u", state: "open" as const, labels: [] }),
      getReviews: async () => [
        { id: 1, author: "me", state: "CHANGES_REQUESTED", body: "", commitId: "sha0001", submittedAt: "t1" },
        { id: 2, author: "peer-bot", state: "CHANGES_REQUESTED", body: "", commitId: "sha0001", submittedAt: "t2" },
      ],
      listRequestedReviewers: async () => ({ users: [], teams: [] }),
    } as any;

    const piWithoutKnownAgents = fakePi();
    registerTools(piWithoutKnownAgents as any, { gh: () => gh, config: () => ({ githubLogin: "me", skillsDir: null, knownAgentLogins: [] }) as any });
    const watchWithout = piWithoutKnownAgents.tools.find((t) => t.name === "pr_watch");
    const resWithout = await watchWithout.execute("id-k1", { repo: "o/r", pr: 4 }, undefined, undefined, undefined);
    expect(JSON.parse(resWithout.content[0].text).action).toBe("hold-for-human"); // peer-bot unknown: reads as human

    const piWithKnownAgents = fakePi();
    registerTools(piWithKnownAgents as any, { gh: () => gh, config: () => ({ githubLogin: "me", skillsDir: null, knownAgentLogins: ["peer-bot"] }) as any });
    const watchWith = piWithKnownAgents.tools.find((t) => t.name === "pr_watch");
    const resWith = await watchWith.execute("id-k2", { repo: "o/r", pr: 4 }, undefined, undefined, undefined);
    expect(JSON.parse(resWith.content[0].text).action).toBe("re-review"); // known agent: does not trip the human rail
  });

  it('pr_expedite reads the repository\'s allowed merge methods when autonomy is "auto" and mergeMethod is omitted', async () => {
    const pi = fakePi();
    const gh: any = fakeExpeditableGh();
    // Simulates a squash-only repository: "merge" (the operation's own fallback) would 405 there.
    gh.getAllowedMergeMethods = async () => ({ merge: false, squash: true, rebase: false });
    registerTools(pi as any, { gh: () => gh, config: () => ({ githubLogin: "me", skillsDir: null, knownAgentLogins: [] }) as any });
    const expediteTool = pi.tools.find((t) => t.name === "pr_expedite");
    const res = await expediteTool.execute("id-e7", { repo: "o/r", pr: 1, autonomy: "auto" }, undefined, undefined, undefined);
    expect(JSON.parse(res.content[0].text).action).toBe("merged");
    expect(gh.merges).toEqual([{ repo: "o/r", pr: 1, sha: HEAD, method: "squash" }]);
  });

  it("pr_expedite prefers a configured mergeMethodByRepo entry over the repository's allowed methods", async () => {
    const pi = fakePi();
    const gh: any = fakeExpeditableGh();
    // Every method is allowed here, so a plain read of the repository would pick "merge" first;
    // the configured per-repo default must win over that.
    gh.getAllowedMergeMethods = async () => ({ merge: true, squash: true, rebase: true });
    registerTools(pi as any, {
      gh: () => gh,
      config: () => ({ githubLogin: "me", skillsDir: null, knownAgentLogins: [], mergeMethodByRepo: { "o/r": "rebase" } }) as any,
    });
    const expediteTool = pi.tools.find((t) => t.name === "pr_expedite");
    const res = await expediteTool.execute("id-e8", { repo: "o/r", pr: 1, autonomy: "auto" }, undefined, undefined, undefined);
    expect(JSON.parse(res.content[0].text).action).toBe("merged");
    expect(gh.merges).toEqual([{ repo: "o/r", pr: 1, sha: HEAD, method: "rebase" }]);
  });

  it("pr_expedite does not probe for a merge method at all in propose mode (no autonomy given)", async () => {
    const pi = fakePi();
    const gh: any = fakeExpeditableGh();
    let probed = false;
    gh.getAllowedMergeMethods = async () => { probed = true; return { merge: true, squash: true, rebase: true }; };
    registerTools(pi as any, { gh: () => gh, config: () => ({ githubLogin: "me", skillsDir: null, knownAgentLogins: [] }) as any });
    const expediteTool = pi.tools.find((t) => t.name === "pr_expedite");
    await expediteTool.execute("id-e9", { repo: "o/r", pr: 1 }, undefined, undefined, undefined);
    expect(probed).toBe(false); // propose mode never merges, so resolving a mergeMethod would be wasted work
  });

  it("pr_approve_dep_upgrade also reads the repository's allowed merge methods when omitted", async () => {
    const pi = fakePi();
    const gh: any = fakeDepUpgradeGh();
    gh.getAllowedMergeMethods = async () => ({ merge: false, squash: false, rebase: true });
    registerTools(pi as any, { gh: () => gh, config: () => ({ githubLogin: "me", skillsDir: null, knownAgentLogins: [] }) as any });
    const approveDep = pi.tools.find((t) => t.name === "pr_approve_dep_upgrade");
    const res = await approveDep.execute("id-d4", { repo: "o/r", pr: 2, autonomy: "auto" }, undefined, undefined, undefined);
    const result = JSON.parse(res.content[0].text);
    expect(result.action).toBe("approved-and-merged");
    expect(gh.merges).toEqual([{ repo: "o/r", pr: 2, sha: HEAD, method: "rebase" }]);
  });

  it("an explicit mergeMethod still wins over both config and the repository's allowed methods", async () => {
    const pi = fakePi();
    const gh: any = fakeExpeditableGh();
    gh.getAllowedMergeMethods = async () => ({ merge: true, squash: false, rebase: false });
    registerTools(pi as any, {
      gh: () => gh,
      config: () => ({ githubLogin: "me", skillsDir: null, knownAgentLogins: [], mergeMethodByRepo: { "o/r": "rebase" } }) as any,
    });
    const expediteTool = pi.tools.find((t) => t.name === "pr_expedite");
    const res = await expediteTool.execute("id-e10", { repo: "o/r", pr: 1, autonomy: "auto", mergeMethod: "squash" }, undefined, undefined, undefined);
    expect(JSON.parse(res.content[0].text).action).toBe("merged");
    expect(gh.merges).toEqual([{ repo: "o/r", pr: 1, sha: HEAD, method: "squash" }]);
  });
});

describe("once", () => {
  it("calls the factory exactly once no matter how many times the wrapper runs, and always returns the same value", () => {
    let calls = 0;
    const wrapped = once(() => { calls += 1; return { built: calls }; });
    const a = wrapped();
    const b = wrapped();
    const c = wrapped();
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("does not call the factory at all until the wrapper is first invoked", () => {
    let calls = 0;
    once(() => { calls += 1; return calls; }); // never invoked below
    expect(calls).toBe(0);
  });
});
