import { describe, it, expect } from "vitest";
import { FakeGitHubGateway } from "../../test/fakes/fake-github.js";
import { completeReview } from "./complete.js";
import { serializeMarker, PRIMARY_MARKER, isPrimaryReview } from "../claim-marker.js";
import { parseMeta } from "../review-meta.js";
import { serializeReviewRecord } from "../review-record.js";

const cfg = { githubLogin: null, skillsDir: null, captureMetadata: false, reviewers: [], knownAgentLogins: [] };
// Capture-on variant, scoped to the footer tests below: the shared `cfg` above must stay
// captureMetadata:false so every existing test keeps exercising today's (no-footer) behavior.
const cfgCapture = { ...cfg, captureMetadata: true, model: "claude-opus-4-8", agent: "claude-code" };
const deps = (gh: FakeGitHubGateway, headSha: string, config = cfg) => ({
  gh, config, workspace: { headSha, clean: true },
});
const blockingFinding = (id = "root-cause") => ({
  id,
  title: "Confirmed regression",
  severity: "high" as const,
  confidence: "confirmed" as const,
  scope: "introduced" as const,
  status: "open" as const,
  blocking: true,
  path: "src/a.ts",
  line: 1,
  evidence: "Reproduced on the claimed commit.",
  remediation: "Fix the bounded root cause.",
});
const changes = (reviewedSha: string, summary: string) => ({
  repo: "o/r", pr: 0, event: "request-changes" as const, summary, reviewedSha,
  findings: [blockingFinding()],
});

describe("completeReview", () => {
  it("rejects completion when the remote head has moved beyond the pinned SHA", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 9, title: "t", author: "a", headSha: "newsha", baseSha: "b", url: "u", state: "open", labels: ["ai-review"] });
    gh.seedRequest("o/r", 9, "me");
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "me", machine: "m", sha: "pinnedsha", claimedAt: "t" }));
    await expect(completeReview(deps(gh, "pinnedsha"), { ...changes("pinnedsha", "fix it"), pr: 9 }))
      .rejects.toThrow(/remote PR head newsha differs from claimed SHA pinnedsha/);
    expect(gh.reviews).toHaveLength(0);
    expect(await gh.listReviewRequests("o/r", "me")).toHaveLength(1);
    expect(await gh.listComments("o/r", 9)).toHaveLength(1);
  });

  it("errors when there is no active claim by this login", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 10, title: "t", author: "a", headSha: "s", baseSha: "b", url: "u", state: "open", labels: ["ai-review"] });
    await expect(completeReview(deps(gh, "s"), { repo: "o/r", pr: 10, event: "comment", summary: "x" })).rejects.toThrow(/claim/i);
  });

  it("rejects completion from a dirty worktree even when HEAD matches the claim", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 18, title: "t", author: "a", headSha: "sha0018", baseSha: "b", url: "u", state: "open", labels: ["ai-review"] });
    await gh.createComment("o/r", 18, serializeMarker({ v: 1, reviewer: "me", sha: "sha0018", claimedAt: "t" }));
    await expect(completeReview(
      { gh, config: cfg, workspace: { headSha: "sha0018", clean: false } },
      { repo: "o/r", pr: 18, event: "approve", summary: "looks good" },
    )).rejects.toThrow(/worktree or index is dirty/);
    expect(gh.reviews).toHaveLength(0);
  });

  it("allows a new high-severity fix regression to block during convergence", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 19, title: "t", author: "a", headSha: "sha0019", baseSha: "b", url: "u", state: "open", labels: ["ai-review"] });
    for (const [index, sha] of ["sha0017", "sha0018"].entries()) {
      const prior = { ...blockingFinding(`prior-${index}`), status: "resolved" as const, blocking: false };
      gh.login = "peer";
      await gh.submitReview("o/r", 19, {
        commitId: sha,
        event: "REQUEST_CHANGES",
        body: `${serializeReviewRecord({ v: 1, reviewedSha: sha, mode: index === 0 ? "initial" : "rereview", role: "primary", verdict: "request-changes", findings: [prior] })}\n\n${PRIMARY_MARKER}`,
      });
    }
    gh.login = "me";
    await gh.createComment("o/r", 19, serializeMarker({ v: 1, reviewer: "me", sha: "sha0019", claimedAt: "t" }));
    const regression = { ...blockingFinding("fix-regression"), scope: "regression" as const };
    const result = await completeReview(deps(gh, "sha0019"), {
      repo: "o/r", pr: 19, event: "request-changes", summary: "the latest fix regressed isolation",
      reviewedSha: "sha0019", mode: "convergence", findings: [regression],
    });
    expect(result.drifted).toBe(false);
    expect(gh.reviews.find((item) => item.author === "me")?.event).toBe("REQUEST_CHANGES");
  });

  it("deletes only an authenticated own marker, never a foreign forged marker", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 17, title: "t", author: "a", headSha: "sha0017", baseSha: "b", url: "u", state: "open", labels: ["ai-review"] });
    gh.login = "maintainer";
    const foreign = await gh.createComment("o/r", 17, serializeMarker({
      v: 1, reviewer: "me", machine: "forged", sha: "sha0017", claimedAt: "t0",
    }));
    gh.login = "me";
    await gh.createComment("o/r", 17, serializeMarker({ v: 1, reviewer: "me", sha: "sha0017", claimedAt: "t1" }));

    await completeReview(deps(gh, "sha0017"), { repo: "o/r", pr: 17, event: "approve", summary: "lgtm" });

    expect(await gh.listComments("o/r", 17)).toEqual([foreign]);
  });

  it("passes inline comments through to the submitted review", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 11, title: "t", author: "a", headSha: "pinnedsha", baseSha: "b", url: "u", state: "open", labels: ["ai-review"] });
    gh.seedRequest("o/r", 11, "me");
    await gh.createComment("o/r", 11, serializeMarker({ v: 1, reviewer: "me", machine: "m", sha: "pinnedsha", claimedAt: "t" }));
    await completeReview(deps(gh, "pinnedsha"), {
      repo: "o/r", pr: 11, event: "comment", summary: "s",
      comments: [{ path: "a.ts", line: 3, body: "note" }],
    });
    expect(gh.reviews[0].comments).toEqual([{ path: "a.ts", line: 3, body: "note" }]);
  });

  it("degrades to a second-opinion COMMENT instead of a competing primary when a primary already exists", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 12, title: "t", author: "a", headSha: "sha0012", baseSha: "b", url: "u", state: "open", labels: ["ai-review"] });
    gh.seedRequest("o/r", 12, "me");
    gh.login = "alice";
    await gh.submitReview("o/r", 12, { commitId: "sha0012", event: "REQUEST_CHANGES", body: `primary\n\n${PRIMARY_MARKER}` });
    gh.login = "me";
    await gh.createComment("o/r", 12, serializeMarker({ v: 1, reviewer: "me", machine: "m", sha: "sha0012", claimedAt: "t" }));
    const res = await completeReview(deps(gh, "sha0012"), { ...changes("sha0012", "also fix this"), pr: 12 });
    const mine = gh.reviews.find((r) => r.author === "me")!;
    expect(mine.event).toBe("COMMENT");
    expect(mine.body).toContain("Second opinion");
    expect(res.superseded).toBe(true);
  });

  it("does NOT downgrade when only a human review (no primary tag) exists", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 13, title: "t", author: "a", headSha: "sha0013", baseSha: "b", url: "u", state: "open", labels: ["ai-review"] });
    gh.seedRequest("o/r", 13, "me");
    gh.login = "human";
    await gh.submitReview("o/r", 13, { commitId: "sha0013", event: "REQUEST_CHANGES", body: "a human review, no agent tag" });
    gh.login = "me";
    await gh.createComment("o/r", 13, serializeMarker({ v: 1, reviewer: "me", machine: "m", sha: "sha0013", claimedAt: "t" }));
    const res = await completeReview(deps(gh, "sha0013"), { repo: "o/r", pr: 13, event: "approve", summary: "lgtm" });
    expect(res.superseded).toBe(false); // a human review is not a competing agent primary
    const mine = gh.reviews.find((r) => r.author === "me")!;
    expect(mine.event).toBe("APPROVE"); // verdict preserved, not downgraded
    expect(mine.body).toContain(PRIMARY_MARKER); // this is the round's primary
  });

  it("does NOT downgrade for a prior round's primary at a different commit", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 15, title: "t", author: "a", headSha: "round2s", baseSha: "b", url: "u", state: "open", labels: ["ai-review"] });
    gh.seedRequest("o/r", 15, "me");
    gh.login = "alice";
    await gh.submitReview("o/r", 15, { commitId: "round1s", event: "APPROVE", body: `round 1 primary\n\n${PRIMARY_MARKER}` }); // prior round, older commit
    gh.login = "me";
    await gh.createComment("o/r", 15, serializeMarker({ v: 1, reviewer: "me", machine: "m", sha: "round2s", claimedAt: "t" }));
    const res = await completeReview(deps(gh, "round2s"), { ...changes("round2s", "round 2"), pr: 15 });
    expect(res.superseded).toBe(false); // prior round's primary is at a different commit, not competing
    const mine = gh.reviews.find((r) => r.author === "me" && r.commitId === "round2s")!;
    expect(mine.event).toBe("REQUEST_CHANGES"); // fresh primary for round 2
  });

  it("rejects stale completion even when a competing primary exists", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 14, title: "t", author: "a", headSha: "newhead", baseSha: "b", url: "u", state: "open", labels: ["ai-review"] });
    gh.seedRequest("o/r", 14, "me");
    gh.login = "alice";
    await gh.submitReview("o/r", 14, { commitId: "pinned0", event: "APPROVE", body: `primary\n\n${PRIMARY_MARKER}` });
    gh.login = "me";
    await gh.createComment("o/r", 14, serializeMarker({ v: 1, reviewer: "me", machine: "m", sha: "pinned0", claimedAt: "t" }));
    await expect(completeReview(deps(gh, "pinned0"), { ...changes("pinned0", "and this"), pr: 14 }))
      .rejects.toThrow(/remote PR head newhead differs from claimed SHA pinned0/);
    expect(gh.reviews.filter((r) => r.author === "me")).toHaveLength(0);
  });

  it("does NOT treat a review that merely quotes the primary tag as a competing primary", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 16, title: "t", author: "a", headSha: "sha0016", baseSha: "b", url: "u", state: "open", labels: ["ai-review"] });
    gh.seedRequest("o/r", 16, "me");
    gh.login = "human";
    // A human review that mentions the marker mid-body (not ending with it); includes() would
    // have wrongly matched this, endsWith() does not.
    await gh.submitReview("o/r", 16, { commitId: "sha0016", event: "COMMENT", body: `the tag \`${PRIMARY_MARKER}\` should move up a line; see the diff` });
    gh.login = "me";
    await gh.createComment("o/r", 16, serializeMarker({ v: 1, reviewer: "me", machine: "m", sha: "sha0016", claimedAt: "t" }));
    const res = await completeReview(deps(gh, "sha0016"), { ...changes("sha0016", "changes"), pr: 16 });
    expect(res.superseded).toBe(false); // a quoted tag is not a real primary
    expect(gh.reviews.find((r) => r.author === "me")!.event).toBe("REQUEST_CHANGES"); // verdict preserved
  });

  it("writes a durable meta footer before the primary marker, preserving isPrimaryReview", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 30, title: "t", author: "a", headSha: "pinned0", baseSha: "b", url: "u", state: "open", labels: ["ai-review"] });
    gh.seedRequest("o/r", 30, "me");
    await gh.createComment("o/r", 30, serializeMarker({ v: 2, reviewer: "me", machine: "mbp", sha: "pinned0", claimedAt: "t0", model: "claude-opus-4-8", agent: "claude-code" }));
    await completeReview(deps(gh, "pinned0", cfgCapture), { repo: "o/r", pr: 30, event: "approve", summary: "lgtm" });
    const body = gh.reviews.find((r) => r.author === "me")!.body;
    expect(isPrimaryReview(body)).toBe(true); // regression guard: the footer sits before the marker, not after
    expect(parseMeta(body)).toMatchObject({
      role: "primary", verdict: "approve", model: "claude-opus-4-8", agent: "claude-code", claimedAt: "t0", machine: "mbp",
    });
  });

  it("writes a second-opinion meta footer with no primary marker when degraded by a competing primary", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 31, title: "t", author: "a", headSha: "sha0031", baseSha: "b", url: "u", state: "open", labels: ["ai-review"] });
    gh.seedRequest("o/r", 31, "me");
    gh.login = "alice";
    await gh.submitReview("o/r", 31, { commitId: "sha0031", event: "REQUEST_CHANGES", body: `primary\n\n${PRIMARY_MARKER}` });
    gh.login = "me";
    await gh.createComment("o/r", 31, serializeMarker({ v: 2, reviewer: "me", machine: "mbp", sha: "sha0031", claimedAt: "t0", model: "claude-opus-4-8", agent: "claude-code" }));
    const res = await completeReview(deps(gh, "sha0031", cfgCapture), { ...changes("sha0031", "also fix this"), pr: 31 });
    expect(res.superseded).toBe(true);
    const mine = gh.reviews.find((r) => r.author === "me")!;
    expect(isPrimaryReview(mine.body)).toBe(false); // a second opinion never carries the primary tag
    expect(parseMeta(mine.body)).toMatchObject({ role: "second-opinion", verdict: "request-changes" });
  });

  it("writes no meta footer when captureMetadata is off (default), preserving today's behavior", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 32, title: "t", author: "a", headSha: "sha0032", baseSha: "b", url: "u", state: "open", labels: ["ai-review"] });
    gh.seedRequest("o/r", 32, "me");
    await gh.createComment("o/r", 32, serializeMarker({ v: 1, reviewer: "me", machine: "m", sha: "sha0032", claimedAt: "t" }));
    const res = await completeReview(deps(gh, "sha0032"), { repo: "o/r", pr: 32, event: "approve", summary: "lgtm" });
    const body = gh.reviews.find((r) => r.author === "me")!.body;
    expect(parseMeta(body)).toBeNull(); // no footer written
    expect(isPrimaryReview(body)).toBe(true); // marker placement unchanged
    expect(res.superseded).toBe(false);
  });
});
