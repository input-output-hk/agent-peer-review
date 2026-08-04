import { describe, it, expect } from "vitest";
import { FakeGitHubGateway } from "./fake-github.js";

describe("FakeGitHubGateway", () => {
  it("clears the review request when a review is submitted", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 1, title: "t", author: "a", headSha: "s", baseSha: "b", url: "u", state: "open", labels: ["agent"] });
    gh.seedRequest("o/r", 1, "me");
    expect(await gh.listReviewRequests("o/r", "me")).toHaveLength(1);
    await gh.submitReview("o/r", 1, { commitId: "s", event: "COMMENT", body: "x" });
    expect(await gh.listReviewRequests("o/r", "me")).toHaveLength(0);
  });

  it("records reviews with author + comments and reads them back", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 1, title: "t", author: "a", headSha: "s", baseSha: "b", url: "u", state: "open", labels: ["agent"] }); gh.seedRequest("o/r", 1, "me");
    await gh.submitReview("o/r", 1, { commitId: "sha1234", event: "REQUEST_CHANGES", body: "primary", comments: [{ path: "a.ts", line: 3, body: "bug" }] });
    const reviews = await gh.getReviews("o/r", 1);
    expect(reviews[0]).toMatchObject({ author: "me", state: "CHANGES_REQUESTED", commitId: "sha1234" });
    expect(await gh.listReviewComments("o/r", 1)).toHaveLength(1);
  });

  it("seeds and reads back pull files, a file's content, and a dir listing; missing keys degrade to []/null", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPullFiles("o/r", 5, ["a.ts", "b.sol"]);
    gh.seedFile("o/r", "deadbeef", "CLAUDE.md", "root claude");
    gh.seedDir("o/r", "deadbeef", ".claude", [".claude/CLAUDE.md", ".claude/notes.md"]);

    expect(await gh.listPullFiles("o/r", 5)).toEqual(["a.ts", "b.sol"]);
    expect(await gh.getFileContent("o/r", "deadbeef", "CLAUDE.md")).toBe("root claude");
    expect(await gh.listDir("o/r", "deadbeef", ".claude")).toEqual([".claude/CLAUDE.md", ".claude/notes.md"]);

    expect(await gh.listPullFiles("o/r", 999)).toEqual([]);
    expect(await gh.getFileContent("o/r", "deadbeef", "nope.md")).toBeNull();
    expect(await gh.listDir("o/r", "deadbeef", "nope")).toEqual([]);
  });

  it("findAgentPulls returns agent-labeled and login-reviewed PRs across all states, deduped; listReviewRequests stays open+requested only", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 40, title: "open labeled", author: "a", headSha: "s40", baseSha: "b", url: "u", state: "open", labels: ["agent"] });
    gh.seedRequest("o/r", 40, "me");
    gh.seedPr({ number: 41, title: "merged labeled", author: "a", headSha: "s41", baseSha: "b", url: "u", state: "merged", labels: ["agent"] });
    gh.seedPr({ number: 42, title: "merged reviewed, unlabeled", author: "a", headSha: "s42", baseSha: "b", url: "u", state: "merged", labels: [] });
    await gh.submitReview("o/r", 42, { commitId: "s42", event: "COMMENT", body: "reviewed by me" });

    const agentPulls = await gh.findAgentPulls("o/r", "me");
    expect(agentPulls.map((p) => p.number).sort()).toEqual([40, 41, 42]);

    const reviewRequests = await gh.listReviewRequests("o/r", "me");
    expect(reviewRequests.map((p) => p.number)).toEqual([40]);
  });

  it("getPullRequest returns seeded created/updated/merged timestamps", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({
      number: 50, title: "t", author: "a", headSha: "s50", baseSha: "b", url: "u", state: "merged", labels: [],
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", mergedAt: "2026-01-03T00:00:00Z",
    });
    const pr = await gh.getPullRequest("o/r", 50);
    expect(pr).toMatchObject({ createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", mergedAt: "2026-01-03T00:00:00Z" });
  });

  it("getPullRequest defaults timestamps when seedPr omits them, so existing callers still compile", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 51, title: "t", author: "a", headSha: "s51", baseSha: "b", url: "u", state: "open", labels: [] });
    const pr = await gh.getPullRequest("o/r", 51);
    expect(typeof pr.createdAt).toBe("string");
    expect(typeof pr.updatedAt).toBe("string");
    expect(pr.mergedAt).toBeNull();
  });
});
