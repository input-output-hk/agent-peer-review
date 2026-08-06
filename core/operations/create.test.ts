import { describe, it, expect } from "vitest";
import { FakeGitHubGateway } from "../../test/fakes/fake-github.js";
import { createReview } from "./create.js";

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
});
