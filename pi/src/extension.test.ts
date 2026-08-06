import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serializeMarker, PRIMARY_MARKER } from "@input-output-hk/agent-review";
import { registerTools } from "./extension.js";

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

describe("pi extension", () => {
  it("registers the six review tools", () => {
    const pi = fakePi();
    registerTools(pi as any, { gh: () => ({}) as any, config: () => ({ githubLogin: "me", skillsDir: null, runChecks: false }) as any });
    expect(pi.tools.map((t) => t.name).sort()).toEqual(
      ["labels_bootstrap", "review_claim", "review_complete", "review_create", "review_enrich", "review_list"]);
  });
  it("review_create falls back to config.reviewers when the call omits reviewers", async () => {
    const pi = fakePi();
    const calls: any = {};
    const gh = {
      addLabels: async () => {},
      requestReviewers: async (_repo: string, _pr: number, reviewers: string[]) => { calls.reviewers = reviewers; },
    } as any;
    registerTools(pi as any, { gh: () => gh, config: () => ({ githubLogin: null, skillsDir: null, runChecks: false, reviewers: ["patextreme"] }) as any });
    const create = pi.tools.find((t) => t.name === "review_create");
    const res = await create.execute("id-create-1", { repo: "o/r", pr: 7 }, undefined, undefined, undefined);
    expect(JSON.parse(res.content[0].text).reviewers).toEqual(["patextreme"]);
    expect(calls.reviewers).toEqual(["patextreme"]); // config default reached the gateway
  });
  it("review_create prefers an explicit reviewers list over the config default", async () => {
    const pi = fakePi();
    const calls: any = {};
    const gh = {
      addLabels: async () => {},
      requestReviewers: async (_repo: string, _pr: number, reviewers: string[]) => { calls.reviewers = reviewers; },
    } as any;
    registerTools(pi as any, { gh: () => gh, config: () => ({ githubLogin: null, skillsDir: null, runChecks: false, reviewers: ["patextreme"] }) as any });
    const create = pi.tools.find((t) => t.name === "review_create");
    const res = await create.execute("id-create-2", { repo: "o/r", pr: 7, reviewers: ["alice"] }, undefined, undefined, undefined);
    expect(JSON.parse(res.content[0].text).reviewers).toEqual(["alice"]);
    expect(calls.reviewers).toEqual(["alice"]); // explicit call wins over the config default
  });
  it("review_create throws a clear error when reviewers are empty everywhere", async () => {
    const pi = fakePi();
    registerTools(pi as any, { gh: () => ({}) as any, config: () => ({ githubLogin: null, skillsDir: null, runChecks: false, reviewers: [] }) as any });
    const create = pi.tools.find((t) => t.name === "review_create");
    await expect(create.execute("id-create-3", { repo: "o/r", pr: 7 }, undefined, undefined, undefined))
      .rejects.toThrow(/no reviewers/i);
  });
  it("review_list wraps the core result in Pi content shape", async () => {
    const pi = fakePi();
    const gh = { getAuthenticatedLogin: async () => "me", listReviewRequests: async () => [], listComments: async () => [] } as any;
    registerTools(pi as any, { gh: () => gh, config: () => ({ githubLogin: null, skillsDir: null, runChecks: false }) as any });
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
    } as any;
    registerTools(pi as any, { gh: () => gh, config: () => ({ githubLogin: null, skillsDir: dir, runChecks: false }) as any });
    const claim = pi.tools.find((t) => t.name === "review_claim");
    const res = await claim.execute("id2", { repo: "o/r", pr: 7 }, undefined, undefined, undefined);
    expect(res.content[0].type).toBe("text");
    const task = JSON.parse(res.content[0].text);
    expect(task.headSha).toBe("feed1234");
    expect(task.reviewer).toBe("me");
    expect(task.role).toBe("anchor");
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
    registerTools(pi as any, { gh: () => gh, config: () => ({ githubLogin: "me", skillsDir: null, runChecks: false }) as any });
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
      submitReview: async (_r: string, _p: number, opts: any) => { calls.submit = opts; return { url: "https://example.com/review/2" }; },
      deleteComment: async () => {},
    } as any;
    registerTools(pi as any, { gh: () => gh, config: () => ({ githubLogin: "me", skillsDir: null, runChecks: false }) as any });
    const enrich = pi.tools.find((t) => t.name === "review_enrich");
    const res = await enrich.execute("id4", { repo: "o/r", pr: 7, verdict: "agree", summary: "concur" }, undefined, undefined, undefined);
    expect(JSON.parse(res.content[0].text).status).toBe("enriched");
    expect(calls.submit.event).toBe("COMMENT");     // enricher posts a COMMENT review
    expect(calls.submit.commitId).toBe("cafe1234"); // at the primary review's commit
    expect(calls.submit.body).toContain("agree");   // p.verdict -> overallVerdict in the body
  });
});
