import { describe, it, expect } from "vitest";
import { FakeGitHubGateway } from "../../test/fakes/fake-github.js";
import { completeReview } from "./complete.js";
import { serializeMarker } from "../claim-marker.js";

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
});
