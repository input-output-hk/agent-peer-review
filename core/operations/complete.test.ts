import { describe, it, expect } from "vitest";
import { FakeGitHubGateway } from "../../test/fakes/fake-github.js";
import { completeReview } from "./complete.js";
import { serializeMarker, PRIMARY_MARKER } from "../claim-marker.js";

const cfg = { githubLogin: null, skillsDir: null, runChecks: false };

describe("completeReview", () => {
  it("submits at the pinned SHA, clears the request, deletes the marker", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 9, title: "t", author: "a", headSha: "newsha", baseSha: "b", url: "u", state: "open", labels: ["agent"] });
    gh.seedRequest("o/r", 9, "me");
    await gh.createComment("o/r", 9, serializeMarker({ v: 1, reviewer: "me", machine: "m", sha: "pinnedsha", claimedAt: "t" }));
    const res = await completeReview({ gh, config: cfg }, { repo: "o/r", pr: 9, event: "request-changes", summary: "fix it" });
    expect(res.drifted).toBe(true); // head moved from pinnedsha -> newsha
    expect(gh.reviews[0]).toMatchObject({ commitId: "pinnedsha", event: "REQUEST_CHANGES" });
    expect(await gh.listReviewRequests("o/r", "me")).toHaveLength(0); // native clear
    expect(await gh.listComments("o/r", 9)).toHaveLength(0); // marker deleted
  });

  it("errors when there is no active claim by this login", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 10, title: "t", author: "a", headSha: "s", baseSha: "b", url: "u", state: "open", labels: ["agent"] });
    await expect(completeReview({ gh, config: cfg }, { repo: "o/r", pr: 10, event: "comment", summary: "x" })).rejects.toThrow(/claim/i);
  });

  it("passes inline comments through to the submitted review", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 11, title: "t", author: "a", headSha: "pinnedsha", baseSha: "b", url: "u", state: "open", labels: ["agent"] });
    gh.seedRequest("o/r", 11, "me");
    await gh.createComment("o/r", 11, serializeMarker({ v: 1, reviewer: "me", machine: "m", sha: "pinnedsha", claimedAt: "t" }));
    await completeReview({ gh, config: cfg }, {
      repo: "o/r", pr: 11, event: "comment", summary: "s",
      comments: [{ path: "a.ts", line: 3, body: "note" }],
    });
    expect(gh.reviews[0].comments).toEqual([{ path: "a.ts", line: 3, body: "note" }]);
  });

  it("degrades to a second-opinion COMMENT instead of a competing primary when a primary already exists", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 12, title: "t", author: "a", headSha: "sha0012", baseSha: "b", url: "u", state: "open", labels: ["agent"] });
    gh.seedRequest("o/r", 12, "me");
    gh.login = "alice";
    await gh.submitReview("o/r", 12, { commitId: "sha0012", event: "REQUEST_CHANGES", body: `primary\n\n${PRIMARY_MARKER}` });
    gh.login = "me";
    await gh.createComment("o/r", 12, serializeMarker({ v: 1, reviewer: "me", machine: "m", sha: "sha0012", claimedAt: "t" }));
    const res = await completeReview({ gh, config: cfg }, { repo: "o/r", pr: 12, event: "request-changes", summary: "also fix this" });
    const mine = gh.reviews.find((r) => r.author === "me")!;
    expect(mine.event).toBe("COMMENT");
    expect(mine.body).toContain("Second opinion");
    expect(res.superseded).toBe(true);
  });

  it("does NOT downgrade when only a human review (no primary tag) exists", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 13, title: "t", author: "a", headSha: "sha0013", baseSha: "b", url: "u", state: "open", labels: ["agent"] });
    gh.seedRequest("o/r", 13, "me");
    gh.login = "human";
    await gh.submitReview("o/r", 13, { commitId: "sha0013", event: "REQUEST_CHANGES", body: "a human review, no agent tag" });
    gh.login = "me";
    await gh.createComment("o/r", 13, serializeMarker({ v: 1, reviewer: "me", machine: "m", sha: "sha0013", claimedAt: "t" }));
    const res = await completeReview({ gh, config: cfg }, { repo: "o/r", pr: 13, event: "approve", summary: "lgtm" });
    expect(res.superseded).toBe(false); // a human review is not a competing agent primary
    const mine = gh.reviews.find((r) => r.author === "me")!;
    expect(mine.event).toBe("APPROVE"); // verdict preserved, not downgraded
    expect(mine.body).toContain(PRIMARY_MARKER); // this is the round's primary
  });

  it("does NOT downgrade for a prior round's primary at a different commit", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 15, title: "t", author: "a", headSha: "round2s", baseSha: "b", url: "u", state: "open", labels: ["agent"] });
    gh.seedRequest("o/r", 15, "me");
    gh.login = "alice";
    await gh.submitReview("o/r", 15, { commitId: "round1s", event: "APPROVE", body: `round 1 primary\n\n${PRIMARY_MARKER}` }); // prior round, older commit
    gh.login = "me";
    await gh.createComment("o/r", 15, serializeMarker({ v: 1, reviewer: "me", machine: "m", sha: "round2s", claimedAt: "t" }));
    const res = await completeReview({ gh, config: cfg }, { repo: "o/r", pr: 15, event: "request-changes", summary: "round 2" });
    expect(res.superseded).toBe(false); // prior round's primary is at a different commit, not competing
    const mine = gh.reviews.find((r) => r.author === "me" && r.commitId === "round2s")!;
    expect(mine.event).toBe("REQUEST_CHANGES"); // fresh primary for round 2
  });

  it("degrades AND notes drift when a competing primary exists and the head has moved", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 14, title: "t", author: "a", headSha: "newhead", baseSha: "b", url: "u", state: "open", labels: ["agent"] });
    gh.seedRequest("o/r", 14, "me");
    gh.login = "alice";
    await gh.submitReview("o/r", 14, { commitId: "pinned0", event: "APPROVE", body: `primary\n\n${PRIMARY_MARKER}` });
    gh.login = "me";
    await gh.createComment("o/r", 14, serializeMarker({ v: 1, reviewer: "me", machine: "m", sha: "pinned0", claimedAt: "t" }));
    const res = await completeReview({ gh, config: cfg }, { repo: "o/r", pr: 14, event: "request-changes", summary: "and this" });
    expect(res.superseded).toBe(true);
    expect(res.drifted).toBe(true);
    const mine = gh.reviews.find((r) => r.author === "me")!;
    expect(mine.event).toBe("COMMENT");
    expect(mine.body).toContain("Second opinion");
    expect(mine.body).toContain("pinned0"); // drift note references the pinned commit
  });

  it("does NOT treat a review that merely quotes the primary tag as a competing primary", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 16, title: "t", author: "a", headSha: "sha0016", baseSha: "b", url: "u", state: "open", labels: ["agent"] });
    gh.seedRequest("o/r", 16, "me");
    gh.login = "human";
    // A human review that mentions the marker mid-body (not ending with it); includes() would
    // have wrongly matched this, endsWith() does not.
    await gh.submitReview("o/r", 16, { commitId: "sha0016", event: "COMMENT", body: `the tag \`${PRIMARY_MARKER}\` should move up a line; see the diff` });
    gh.login = "me";
    await gh.createComment("o/r", 16, serializeMarker({ v: 1, reviewer: "me", machine: "m", sha: "sha0016", claimedAt: "t" }));
    const res = await completeReview({ gh, config: cfg }, { repo: "o/r", pr: 16, event: "request-changes", summary: "changes" });
    expect(res.superseded).toBe(false); // a quoted tag is not a real primary
    expect(gh.reviews.find((r) => r.author === "me")!.event).toBe("REQUEST_CHANGES"); // verdict preserved
  });
});
