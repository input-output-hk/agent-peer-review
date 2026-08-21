import { describe, it, expect } from "vitest";
import { FakeGitHubGateway } from "../../test/fakes/fake-github.js";
import { createReview } from "./create.js";
import { serializeSelfReviewMarker } from "../self-review.js";

describe("createReview", () => {
  it("adds agent + skill labels and requests the reviewer natively", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 7, title: "t", author: "a", headSha: "s", baseSha: "b", url: "u", state: "open", labels: [] });
    const res = await createReview(gh, { repo: "o/r", pr: 7, skills: ["security"], reviewers: ["yshyn-iohk"], note: "please review" });
    expect(res.labelsAdded).toEqual(["ai-review", "security"]);
    const pr = await gh.getPullRequest("o/r", 7);
    expect(pr.labels).toEqual(expect.arrayContaining(["ai-review", "security"]));
    expect(await gh.listReviewRequests("o/r", "yshyn-iohk")).toHaveLength(1);
    expect((await gh.listComments("o/r", 7))[0].body).toContain("please review");
  });

  it("requires a current-head authenticated self-review when the caller is the PR author", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 8, title: "t", author: "me", headSha: "sha0008", baseSha: "b", url: "u", state: "open", labels: [] });
    await expect(createReview(gh, { repo: "o/r", pr: 8, skills: [], reviewers: ["peer"] }))
      .rejects.toThrow(/Self-review/);
    expect((await gh.getPullRequest("o/r", 8)).labels).toEqual([]);

    await gh.createComment("o/r", 8, `## Self-review\n\n${serializeSelfReviewMarker({
      v: 1, author: "me", sha: "sha0008", status: "passed",
    })}`);
    await expect(createReview(gh, { repo: "o/r", pr: 8, skills: [], reviewers: ["peer"] }))
      .resolves.toMatchObject({ reviewers: ["peer"] });
  });
});
