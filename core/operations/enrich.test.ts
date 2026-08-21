import { describe, it, expect } from "vitest";
import { FakeGitHubGateway } from "../../test/fakes/fake-github.js";
import { enrichReview, DEFAULT_CLAIM_TTL_MS } from "./enrich.js";
import { serializeMarker, parseMarkers, PRIMARY_MARKER } from "../claim-marker.js";
import { parseMeta } from "../review-meta.js";
const cfg = { githubLogin: null as string | null, skillsDir: null, captureMetadata: false, reviewers: [], knownAgentLogins: [] };
// Capture-on variant, scoped to the footer tests below: the shared `cfg` above must stay
// captureMetadata:false so every existing test keeps exercising today's (no-footer) behavior.
const cfgCapture = { ...cfg, captureMetadata: true, model: "claude-opus-4-8", agent: "claude-code" };
const TTL = DEFAULT_CLAIM_TTL_MS;

function panelPr(gh: FakeGitHubGateway) {
  gh.seedPr({ number: 9, title: "t", author: "a", headSha: "head", baseSha: "b", url: "u", state: "open", labels: ["ai-review"] });
  gh.seedRequest("o/r", 9, "alice"); gh.seedRequest("o/r", 9, "bob");
}

describe("enrichReview", () => {
  it("keeps one 30-minute claim-staleness policy for every adapter", () => {
    expect(DEFAULT_CLAIM_TTL_MS).toBe(30 * 60_000);
  });

  it("submits ONE consolidated COMMENT review at the primary's commit when the primary exists", async () => {
    const gh = new FakeGitHubGateway(); panelPr(gh);
    // alice claims + posts primary
    gh.login = "alice";
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "alice", machine: "m1", sha: "primsha", claimedAt: "2026-07-30T00:00:00Z" }));
    await gh.submitReview("o/r", 9, { commitId: "primsha", event: "REQUEST_CHANGES", body: `primary\n\n${PRIMARY_MARKER}`, comments: [{ path: "a.ts", line: 3, body: "bug" }] });
    // bob claims at the same head as alice, then enriches
    gh.login = "bob";
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "bob", machine: "m2", sha: "primsha", claimedAt: "2026-07-30T00:01:00Z" }));
    const res = await enrichReview({ gh, config: cfg, ttlMs: TTL, nowMs: Date.parse("2026-07-30T00:02:00Z") },
      { repo: "o/r", pr: 9, overallVerdict: "mixed", summary: "agree on the bug; found one more", newFindings: [{ path: "b.ts", line: 7, body: "also here" }] });
    expect(res.status).toBe("enriched");
    const bobReview = gh.reviews.find((r) => r.author === "bob")!;
    expect(bobReview).toMatchObject({ event: "COMMENT", commitId: "primsha" });
    expect(await gh.listReviewComments("o/r", 9)).toHaveLength(2); // alice's + bob's new finding
    expect((await gh.listReviewRequests("o/r", "bob"))).toHaveLength(0); // de-queued
  });
  it("deletes only the enricher's authenticated marker, never a foreign forged marker", async () => {
    const gh = new FakeGitHubGateway(); panelPr(gh);
    gh.login = "alice";
    await gh.submitReview("o/r", 9, { commitId: "head0009", event: "APPROVE", body: `primary\n\n${PRIMARY_MARKER}` });
    gh.login = "maintainer";
    const foreign = await gh.createComment("o/r", 9, serializeMarker({
      v: 1, reviewer: "bob", machine: "forged", sha: "head0009", claimedAt: "t0",
    }));
    gh.login = "bob";
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "bob", sha: "head0009", claimedAt: "t1" }));

    expect((await enrichReview(
      { gh, config: cfg, ttlMs: TTL, nowMs: 0 },
      { repo: "o/r", pr: 9, overallVerdict: "agree", summary: "confirmed" },
    )).status).toBe("enriched");
    expect(await gh.listComments("o/r", 9)).toEqual([foreign]);
  });
  it("does not enrich a prior round's stale primary before this round's primary is posted", async () => {
    const gh = new FakeGitHubGateway(); panelPr(gh);
    // A round-1 primary exists at an older commit (tagged), left over from a previous cycle.
    gh.login = "alice";
    await gh.submitReview("o/r", 9, { commitId: "round1s", event: "REQUEST_CHANGES", body: `round 1\n\n${PRIMARY_MARKER}` });
    // Round 2: alice and bob re-claim at the new head; no round-2 primary posted yet.
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "alice", machine: "m1", sha: "round2s", claimedAt: "2026-07-30T02:00:00Z" }));
    gh.login = "bob";
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "bob", machine: "m2", sha: "round2s", claimedAt: "2026-07-30T02:01:00Z" }));
    const res = await enrichReview({ gh, config: cfg, ttlMs: TTL, nowMs: Date.parse("2026-07-30T02:02:00Z") },
      { repo: "o/r", pr: 9, overallVerdict: "agree", summary: "s" });
    expect(res.status).toBe("waiting"); // round-1's primary is at a different commit, so bob waits for round 2's rather than enriching the stale one
  });
  it("returns waiting when no primary yet and the anchor marker is fresh", async () => {
    const gh = new FakeGitHubGateway(); panelPr(gh);
    gh.login = "alice";
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "alice", machine: "m1", sha: "headsha", claimedAt: "2026-07-30T00:00:00Z" }));
    gh.login = "bob";
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "bob", machine: "m2", sha: "headsha", claimedAt: "2026-07-30T00:01:00Z" }));
    const res = await enrichReview({ gh, config: cfg, ttlMs: TTL, nowMs: Date.parse("2026-07-30T00:02:00Z") },
      { repo: "o/r", pr: 9, overallVerdict: "agree", summary: "s" });
    expect(res.status).toBe("waiting");
  });
  it("returns promote when no primary and the anchor marker is stale past TTL", async () => {
    const gh = new FakeGitHubGateway(); panelPr(gh);
    gh.login = "alice";
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "alice", machine: "m1", sha: "headsha", claimedAt: "2026-07-30T00:00:00Z" }));
    gh.login = "bob";
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "bob", machine: "m2", sha: "headsha", claimedAt: "2026-07-30T00:01:00Z" }));
    const res = await enrichReview({ gh, config: cfg, ttlMs: TTL, nowMs: Date.parse("2026-07-30T01:00:00Z") },
      { repo: "o/r", pr: 9, overallVerdict: "agree", summary: "s" });
    expect(res.status).toBe("promote");
  });
  it("recovers from a stale anchor without deadlocking: promotion deletes the anchor's marker so the next stale anchor can also be superseded", async () => {
    const gh = new FakeGitHubGateway(); panelPr(gh);
    gh.seedRequest("o/r", 9, "carol");
    gh.login = "alice";
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "alice", machine: "m1", sha: "headsha", claimedAt: "2026-07-30T00:00:00Z" }));
    gh.login = "bob";
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "bob", machine: "m2", sha: "headsha", claimedAt: "2026-07-30T00:01:00Z" }));
    gh.login = "carol";
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "carol", machine: "m3", sha: "headsha", claimedAt: "2026-07-30T00:02:00Z" }));
    const nowMs = Date.parse("2026-07-30T01:00:00Z"); // ~1h past all three claims; TTL is 30m

    gh.login = "bob";
    const bobRes = await enrichReview({ gh, config: cfg, ttlMs: TTL, nowMs }, { repo: "o/r", pr: 9, overallVerdict: "agree", summary: "s" });
    expect(bobRes.status).toBe("promote"); // earliest surviving (non-anchor) marker
    expect(parseMarkers(await gh.listComments("o/r", 9)).some((m) => m.marker.reviewer === "alice")).toBe(false); // stale anchor's marker cleaned up so bob cannot deadlock the panel if he stalls too

    gh.login = "carol";
    const carolRes = await enrichReview({ gh, config: cfg, ttlMs: TTL, nowMs }, { repo: "o/r", pr: 9, overallVerdict: "agree", summary: "s" });
    expect(carolRes.status).toBe("promote"); // bob, the new anchor, is itself stale with no primary, so carol takes over too; no deadlock
  });

  it("converges once the promoted enricher posts a primary: the next enrich reports enriched, not promote", async () => {
    const gh = new FakeGitHubGateway(); panelPr(gh);
    gh.seedRequest("o/r", 9, "carol");
    gh.login = "alice";
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "alice", machine: "m1", sha: "headsha", claimedAt: "2026-07-30T00:00:00Z" }));
    gh.login = "bob";
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "bob", machine: "m2", sha: "headsha", claimedAt: "2026-07-30T00:01:00Z" }));
    gh.login = "carol";
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "carol", machine: "m3", sha: "headsha", claimedAt: "2026-07-30T00:02:00Z" }));
    const nowMs = Date.parse("2026-07-30T01:00:00Z");

    gh.login = "bob";
    const bobRes = await enrichReview({ gh, config: cfg, ttlMs: TTL, nowMs }, { repo: "o/r", pr: 9, overallVerdict: "agree", summary: "s" });
    expect(bobRes.status).toBe("promote");
    await gh.submitReview("o/r", 9, { commitId: "headsha", event: "REQUEST_CHANGES", body: `bob's primary\n\n${PRIMARY_MARKER}` });

    gh.login = "carol";
    const carolRes = await enrichReview({ gh, config: cfg, ttlMs: TTL, nowMs }, { repo: "o/r", pr: 9, overallVerdict: "agree", summary: "s" });
    expect(carolRes.status).toBe("enriched"); // a primary now exists, so carol enriches instead of promoting
  });

  it("writes a second-opinion meta footer when enriching, with captureMetadata on", async () => {
    const gh = new FakeGitHubGateway(); panelPr(gh);
    gh.login = "alice";
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "alice", machine: "m1", sha: "primsha", claimedAt: "2026-07-30T00:00:00Z" }));
    await gh.submitReview("o/r", 9, { commitId: "primsha", event: "REQUEST_CHANGES", body: `primary\n\n${PRIMARY_MARKER}` });
    gh.login = "bob";
    await gh.createComment("o/r", 9, serializeMarker({ v: 2, reviewer: "bob", machine: "m2", sha: "primsha", claimedAt: "2026-07-30T00:01:00Z", model: "claude-opus-4-8", agent: "claude-code" }));
    const res = await enrichReview({ gh, config: cfgCapture, ttlMs: TTL, nowMs: Date.parse("2026-07-30T00:02:00Z") },
      { repo: "o/r", pr: 9, overallVerdict: "agree", summary: "confirmed" });
    expect(res.status).toBe("enriched");
    const bobReview = gh.reviews.find((r) => r.author === "bob")!;
    expect(parseMeta(bobReview.body)).toMatchObject({
      role: "second-opinion", verdict: "agree", model: "claude-opus-4-8", agent: "claude-code", machine: "m2",
    });
  });

  it("writes no meta footer when enriching with captureMetadata off (default)", async () => {
    const gh = new FakeGitHubGateway(); panelPr(gh);
    gh.login = "alice";
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "alice", machine: "m1", sha: "primsha", claimedAt: "2026-07-30T00:00:00Z" }));
    await gh.submitReview("o/r", 9, { commitId: "primsha", event: "REQUEST_CHANGES", body: `primary\n\n${PRIMARY_MARKER}` });
    gh.login = "bob";
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "bob", machine: "m2", sha: "primsha", claimedAt: "2026-07-30T00:01:00Z" }));
    const res = await enrichReview({ gh, config: cfg, ttlMs: TTL, nowMs: Date.parse("2026-07-30T00:02:00Z") },
      { repo: "o/r", pr: 9, overallVerdict: "agree", summary: "confirmed" });
    expect(res.status).toBe("enriched");
    const bobReview = gh.reviews.find((r) => r.author === "bob")!;
    expect(parseMeta(bobReview.body)).toBeNull(); // no footer written
  });
});
