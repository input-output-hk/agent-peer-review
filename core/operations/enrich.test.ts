import { describe, it, expect } from "vitest";
import { FakeGitHubGateway } from "../../test/fakes/fake-github.js";
import { enrichReview } from "./enrich.js";
import { serializeMarker } from "../claim-marker.js";
const cfg = { githubLogin: null as string | null, skillsDir: null, runChecks: false };
const TTL = 30 * 60_000;

function panelPr(gh: FakeGitHubGateway) {
  gh.seedPr({ number: 9, title: "t", author: "a", headSha: "head", baseSha: "b", url: "u", state: "open", labels: ["agent"] });
  gh.seedRequest("o/r", 9, "alice"); gh.seedRequest("o/r", 9, "bob");
}

describe("enrichReview", () => {
  it("submits ONE consolidated COMMENT review at the primary's commit when the primary exists", async () => {
    const gh = new FakeGitHubGateway(); panelPr(gh);
    // alice claims + posts primary
    gh.login = "alice";
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "alice", machine: "m1", sha: "primsha", claimedAt: "2026-07-30T00:00:00Z" }));
    await gh.submitReview("o/r", 9, { commitId: "primsha", event: "REQUEST_CHANGES", body: "primary", comments: [{ path: "a.ts", line: 3, body: "bug" }] });
    // bob claims then enriches
    gh.login = "bob";
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "bob", machine: "m2", sha: "headsha", claimedAt: "2026-07-30T00:01:00Z" }));
    const res = await enrichReview({ gh, config: cfg, ttlMs: TTL, nowMs: Date.parse("2026-07-30T00:02:00Z") },
      { repo: "o/r", pr: 9, overallVerdict: "mixed", summary: "agree on the bug; found one more", newFindings: [{ path: "b.ts", line: 7, body: "also here" }] });
    expect(res.status).toBe("enriched");
    const bobReview = gh.reviews.find((r) => r.author === "bob")!;
    expect(bobReview).toMatchObject({ event: "COMMENT", commitId: "primsha" });
    expect(await gh.listReviewComments("o/r", 9)).toHaveLength(2); // alice's + bob's new finding
    expect((await gh.listReviewRequests("o/r", "bob"))).toHaveLength(0); // de-queued
  });
  it("returns waiting when no primary yet and the anchor marker is fresh", async () => {
    const gh = new FakeGitHubGateway(); panelPr(gh);
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "alice", machine: "m1", sha: "headsha", claimedAt: "2026-07-30T00:00:00Z" }));
    gh.login = "bob";
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "bob", machine: "m2", sha: "headsha", claimedAt: "2026-07-30T00:01:00Z" }));
    const res = await enrichReview({ gh, config: cfg, ttlMs: TTL, nowMs: Date.parse("2026-07-30T00:02:00Z") },
      { repo: "o/r", pr: 9, overallVerdict: "agree", summary: "s" });
    expect(res.status).toBe("waiting");
  });
  it("returns promote when no primary and the anchor marker is stale past TTL", async () => {
    const gh = new FakeGitHubGateway(); panelPr(gh);
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "alice", machine: "m1", sha: "headsha", claimedAt: "2026-07-30T00:00:00Z" }));
    gh.login = "bob";
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "bob", machine: "m2", sha: "headsha", claimedAt: "2026-07-30T00:01:00Z" }));
    const res = await enrichReview({ gh, config: cfg, ttlMs: TTL, nowMs: Date.parse("2026-07-30T01:00:00Z") },
      { repo: "o/r", pr: 9, overallVerdict: "agree", summary: "s" });
    expect(res.status).toBe("promote");
  });
  it("promotes only the earliest surviving enricher when a 3-reviewer panel's anchor is stale", async () => {
    const gh = new FakeGitHubGateway(); panelPr(gh);
    gh.seedRequest("o/r", 9, "carol");
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "alice", machine: "m1", sha: "headsha", claimedAt: "2026-07-30T00:00:00Z" }));
    gh.login = "bob";
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "bob", machine: "m2", sha: "headsha", claimedAt: "2026-07-30T00:01:00Z" }));
    gh.login = "carol";
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "carol", machine: "m3", sha: "headsha", claimedAt: "2026-07-30T00:02:00Z" }));
    const nowMs = Date.parse("2026-07-30T01:00:00Z"); // 1h past alice's (the anchor's) claim; TTL is 30m
    gh.login = "bob";
    const bobRes = await enrichReview({ gh, config: cfg, ttlMs: TTL, nowMs }, { repo: "o/r", pr: 9, overallVerdict: "agree", summary: "s" });
    gh.login = "carol";
    const carolRes = await enrichReview({ gh, config: cfg, ttlMs: TTL, nowMs }, { repo: "o/r", pr: 9, overallVerdict: "agree", summary: "s" });
    expect(bobRes.status).toBe("promote"); // earliest surviving (non-anchor) marker
    expect(carolRes.status).toBe("waiting"); // defers to bob
  });
});
