import { describe, it, expect } from "vitest";
import { FakeGitHubGateway } from "../../test/fakes/fake-github.js";
import { runEnrichLoop } from "./enrich-loop.js";
import { serializeMarker, PRIMARY_MARKER } from "../claim-marker.js";

const cfg = { githubLogin: null as string | null, skillsDir: null, runChecks: false };
const TTL = 30 * 60_000;
const noSleep = async (): Promise<void> => { throw new Error("runEnrichLoop should not have slept"); };

function panelPr(gh: FakeGitHubGateway) {
  gh.seedPr({ number: 9, title: "t", author: "a", headSha: "headsha", baseSha: "b", url: "u", state: "open", labels: ["agent"] });
  gh.seedRequest("o/r", 9, "alice"); gh.seedRequest("o/r", 9, "bob");
}

describe("runEnrichLoop", () => {
  it("resolves enriched on the first poll when a primary already exists (no sleep needed)", async () => {
    const gh = new FakeGitHubGateway(); panelPr(gh);
    gh.login = "alice";
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "alice", machine: "m1", sha: "headsha", claimedAt: "2026-07-30T00:00:00Z" }));
    await gh.submitReview("o/r", 9, { commitId: "headsha", event: "REQUEST_CHANGES", body: `primary\n\n${PRIMARY_MARKER}` });
    gh.login = "bob";
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "bob", machine: "m2", sha: "headsha", claimedAt: "2026-07-30T00:01:00Z" }));
    const now = () => Date.parse("2026-07-30T00:02:00Z");

    const res = await runEnrichLoop(
      { gh, config: cfg, ttlMs: TTL, now, sleep: noSleep },
      { repo: "o/r", pr: 9, overallVerdict: "mixed", summary: "agree on the bug; found one more", newFindings: [{ path: "b.ts", line: 7, body: "also here" }] },
      { pollMs: 5000, deadlineMs: now() + TTL },
    );

    expect(res.outcome).toBe("enriched");
    expect(res.result).toMatchObject({ status: "enriched" });
    const bobReview = gh.reviews.find((r) => r.author === "bob")!;
    expect(bobReview).toMatchObject({ event: "COMMENT", commitId: "headsha" });
  });

  it("promotes the caller and posts the primary via completeReview when the anchor is stale", async () => {
    const gh = new FakeGitHubGateway(); panelPr(gh);
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "alice", machine: "m1", sha: "headsha", claimedAt: "2026-07-30T00:00:00Z" }));
    gh.login = "bob";
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "bob", machine: "m2", sha: "headsha", claimedAt: "2026-07-30T00:01:00Z" }));
    const nowMs = Date.parse("2026-07-30T01:00:00Z"); // ~1h past alice's claim; TTL is 30m, so she is stale

    const res = await runEnrichLoop(
      { gh, config: cfg, ttlMs: TTL, now: () => nowMs, sleep: noSleep },
      { repo: "o/r", pr: 9, overallVerdict: "agree", summary: "looks fine" },
      { pollMs: 5000, deadlineMs: nowMs + TTL },
    );

    expect(res.outcome).toBe("promoted");
    expect(res.result).toMatchObject({ superseded: false });
    const primary = gh.reviews.find((r) => r.author === "bob")!;
    expect(primary).toMatchObject({ commitId: "headsha", event: "APPROVE" });
  });

  it("treats a marker race between promote and complete as a benign hand-off, not a crash", async () => {
    // Simulates: the panel's stale-cascade sweeps bob's own claim marker away in the instant
    // between enrichReview resolving "promote" and completeReview reading the claim back. There is
    // no sleep between those two calls, so the race is injected via the gh call completeReview makes
    // first (getPullRequest), which enrichReview never calls.
    let bobMarkerId = -1;
    class RacyGateway extends FakeGitHubGateway {
      async getPullRequest(repo: string, pr: number) {
        await this.deleteComment(repo, bobMarkerId);
        return super.getPullRequest(repo, pr);
      }
    }
    const gh = new RacyGateway(); panelPr(gh);
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "alice", machine: "m1", sha: "headsha", claimedAt: "2026-07-30T00:00:00Z" }));
    gh.login = "bob";
    const bobMarker = await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "bob", machine: "m2", sha: "headsha", claimedAt: "2026-07-30T00:01:00Z" }));
    bobMarkerId = bobMarker.id;
    const nowMs = Date.parse("2026-07-30T01:00:00Z");

    const res = await runEnrichLoop(
      { gh, config: cfg, ttlMs: TTL, now: () => nowMs, sleep: noSleep },
      { repo: "o/r", pr: 9, overallVerdict: "agree", summary: "looks fine" },
      { pollMs: 5000, deadlineMs: nowMs + TTL },
    );

    expect(res.outcome).toBe("superseded");
    expect(res.result).toBeUndefined();
    expect(gh.reviews).toHaveLength(0); // completeReview never got to submit
  });

  it("polls until the deadline, then returns timeout without looping forever", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 9, title: "t", author: "a", headSha: "headsha", baseSha: "b", url: "u", state: "open", labels: ["agent"] });
    gh.login = "bob";
    // bob is the sole (hence "earliest") marker, so he can never be stale relative to himself:
    // enrichReview reports "waiting" forever regardless of how far now() advances.
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "bob", machine: "m1", sha: "headsha", claimedAt: "2026-07-30T00:00:00Z" }));
    let t = Date.parse("2026-07-30T00:00:30Z");
    const deadlineMs = t + 5000;
    let sleeps = 0;
    const res = await runEnrichLoop(
      { gh, config: cfg, ttlMs: TTL, now: () => t, sleep: async (_ms: number) => { sleeps++; t += 60 * 60_000; } },
      { repo: "o/r", pr: 9, overallVerdict: "agree", summary: "s" },
      { pollMs: 10, deadlineMs },
    );
    expect(res.outcome).toBe("timeout");
    expect(sleeps).toBe(1); // one poll, then the next now() reading crossed the deadline
  });
});
