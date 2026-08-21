import { describe, expect, it } from "vitest";
import { FakeGitHubGateway } from "../../test/fakes/fake-github.js";
import { parseSelfReviewMarker, serializeSelfReviewMarker } from "../self-review.js";
import { recordSelfReview } from "./record-self-review.js";

const input = {
  repo: "o/r", pr: 1, reviewedSha: "sha0001",
  whatChanged: "Implemented the bounded review convergence contract across every adapter.",
  howVerified: "Ran the focused state-machine tests and the complete repository test suite.",
  whyReady: "All identified issues are resolved and exact-head checks pass on a clean tree.",
};

function seeded(): FakeGitHubGateway {
  const gh = new FakeGitHubGateway();
  gh.seedPr({ number: 1, title: "t", author: "me", headSha: "sha0001", baseSha: "b", url: "u", state: "open", labels: [] });
  return gh;
}

describe("recordSelfReview", () => {
  it("posts one titled, structured summary per head and is idempotent", async () => {
    const gh = seeded();
    const first = await recordSelfReview({ gh, workspace: { headSha: "sha0001", clean: true } }, input);
    const second = await recordSelfReview({ gh, workspace: { headSha: "sha0001", clean: true } }, input);
    expect(first.status).toBe("recorded");
    expect(second).toEqual({ status: "already-recorded", commentId: first.commentId, headSha: "sha0001" });
    const comments = await gh.listComments("o/r", 1);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("## Self-review");
    expect(comments[0].body).toContain("### What changed");
    expect(comments[0].body).toContain("### How it was fixed and verified");
    expect(comments[0].body).toContain("### Why this is ready for peer review");
    expect(parseSelfReviewMarker(comments[0].body)).toMatchObject({ sha: "sha0001", status: "passed" });
  });

  it("fails closed on dirty, stale, or non-author evidence", async () => {
    const dirty = seeded();
    await expect(recordSelfReview({ gh: dirty, workspace: { headSha: "sha0001", clean: false } }, input))
      .rejects.toThrow(/dirty/);

    const stale = seeded();
    stale.prs.get("o/r#1")!.headSha = "sha0002";
    await expect(recordSelfReview({ gh: stale, workspace: { headSha: "sha0001", clean: true } }, input))
      .rejects.toThrow(/remote PR head/);

    const foreign = seeded();
    foreign.login = "reviewer";
    await expect(recordSelfReview({ gh: foreign, workspace: { headSha: "sha0001", clean: true } }, input))
      .rejects.toThrow(/pull request author me/);
  });

  it("does not accept or delete a forged marker in somebody else's comment", async () => {
    const gh = seeded();
    gh.login = "maintainer";
    const forged = await gh.createComment("o/r", 1, serializeSelfReviewMarker({ v: 1, author: "me", sha: "sha0001", status: "passed" }));
    gh.login = "me";
    await recordSelfReview({ gh, workspace: { headSha: "sha0001", clean: true } }, input);
    expect(await gh.listComments("o/r", 1)).toContainEqual(forged);
    expect(await gh.listComments("o/r", 1)).toHaveLength(2);
  });
});
