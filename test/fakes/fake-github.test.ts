import { describe, it, expect } from "vitest";
import { FakeGitHubGateway } from "./fake-github.js";
import { evaluateGates, type GateInput } from "../../core/expedition/gate.js";
import type { Mergeability } from "../../core/github.js";

/** Gate input where every rail passes, so a single field can be varied to see what that field costs. */
const GATE_INPUT_ALL_PASSING: GateInput = {
  classification: { categories: ["docs"], autoEligible: true, sawSourceOrTest: false, byFile: [{ file: "README.md", category: "docs" }] },
  changedFiles: 1,
  changedLines: 2,
  checks: "green",
  mergeableState: "clean",
  branchProtectionSatisfied: true,
  hasNewSecurityAlert: false,
  humanReviewPending: false,
  humanChangesRequested: false,
  autonomy: "auto",
  headShaGuardPassed: true,
  actingLogin: "me",
  author: "someone-else",
  isApproving: false,
};

describe("FakeGitHubGateway", () => {
  it("clears the review request when a review is submitted", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 1, title: "t", author: "a", headSha: "s", baseSha: "b", url: "u", state: "open", labels: ["ai-review"] });
    gh.seedRequest("o/r", 1, "me");
    expect(await gh.listReviewRequests("o/r", "me")).toHaveLength(1);
    await gh.submitReview("o/r", 1, { commitId: "s", event: "COMMENT", body: "x" });
    expect(await gh.listReviewRequests("o/r", "me")).toHaveLength(0);
  });

  it("records reviews with author + comments and reads them back", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 1, title: "t", author: "a", headSha: "s", baseSha: "b", url: "u", state: "open", labels: ["ai-review"] }); gh.seedRequest("o/r", 1, "me");
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

  it("findAgentPulls returns ai-review-labeled and login-reviewed PRs across all states, deduped; listReviewRequests stays open+requested only", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 40, title: "open labeled", author: "a", headSha: "s40", baseSha: "b", url: "u", state: "open", labels: ["ai-review"] });
    gh.seedRequest("o/r", 40, "me");
    gh.seedPr({ number: 41, title: "merged labeled", author: "a", headSha: "s41", baseSha: "b", url: "u", state: "merged", labels: ["ai-review"] });
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

describe("FakeGitHubGateway expedition methods (PR 3)", () => {
  // A guard on the fake itself, not on the code under test. The default used to be "clean", which let
  // a test seed branch protection requiring an approving review AND be handed a clean mergeable
  // state: a combination GitHub cannot produce (it reports "blocked" while the review is missing).
  // Tests asserted that impossible world and passed, which hid a production deadlock on gate rail 4
  // through two review passes. The default must therefore stay a state that FAILS the gate, so a test
  // that cares has to say which state it means.
  it("getMergeability defaults to a state that fails the gate, and setMergeability overrides it", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 1, title: "t", author: "a", headSha: "headsha1", baseSha: "b", url: "u", state: "open", labels: [] });

    const unseeded = await gh.getMergeability("o/r", 1);
    expect(unseeded).toEqual({ state: "unknown", mergeable: null, draft: false, baseRef: "main", headSha: "headsha1" });
    // Stated as the property that matters, so this fails if the default ever silently becomes a
    // passing state again. "clean" is the only state rail 4 accepts outright, and "blocked" is the one
    // it accepts from an approver, so neither may be the default.
    expect(unseeded.state).not.toBe("clean");
    expect(unseeded.state).not.toBe("blocked");
    // The cast is the assertion's point rather than a shortcut: Mergeability carries a "draft" member
    // the gate deliberately does not model, and this test is about the state the fake actually
    // returned, which is not that one.
    expect(unseeded.state).not.toBe("draft");
    expect(evaluateGates({ ...GATE_INPUT_ALL_PASSING, mergeableState: unseeded.state as GateInput["mergeableState"] }).action).toBe("propose");

    gh.setMergeability("o/r", 1, { state: "dirty", mergeable: false, draft: false, baseRef: "main", headSha: "headsha1" });
    expect((await gh.getMergeability("o/r", 1)).state).toBe("dirty");
  });

  it("getChecks defaults to [] and setChecks overrides it", async () => {
    const gh = new FakeGitHubGateway();
    expect(await gh.getChecks("o/r", "deadbeef")).toEqual([]);
    gh.setChecks("o/r", "deadbeef", [{ name: "build", status: "failure" }]);
    expect(await gh.getChecks("o/r", "deadbeef")).toEqual([{ name: "build", status: "failure" }]);
  });

  it('getBranchProtection defaults to "none" and setBranchProtection can arrange "unknown" or a summary', async () => {
    const gh = new FakeGitHubGateway();
    expect(await gh.getBranchProtection("o/r", "main")).toBe("none");
    gh.setBranchProtection("o/r", "main", "unknown");
    expect(await gh.getBranchProtection("o/r", "main")).toBe("unknown");
    gh.setBranchProtection("o/r", "main", {
      requiresPullRequestReviews: true, requiredApprovingReviewCount: 0,
      requiredChecks: ["ci"], enforceAdmins: true, requiresConversationResolution: false,
      dismissesStaleReviews: false,
    });
    expect(await gh.getBranchProtection("o/r", "main")).toEqual({
      requiresPullRequestReviews: true, requiredApprovingReviewCount: 0,
      requiredChecks: ["ci"], enforceAdmins: true, requiresConversationResolution: false,
      dismissesStaleReviews: false,
    });
  });

  // Mirrored so a test can arrange the branch that retires stale approvals itself, which is the one
  // case where rail 5 may count an approval of a commit that is no longer the head (issue #53).
  it("round-trips dismissesStaleReviews", async () => {
    const gh = new FakeGitHubGateway();
    gh.setBranchProtection("o/r", "main", {
      requiresPullRequestReviews: true, requiredApprovingReviewCount: 1,
      requiredChecks: [], enforceAdmins: false, requiresConversationResolution: false,
      dismissesStaleReviews: true,
    });
    expect(await gh.getBranchProtection("o/r", "main")).toMatchObject({ dismissesStaleReviews: true });
  });

  it("getBranchProtection returns a deep copy: mutating a returned requiredChecks array does not corrupt the stored state", async () => {
    const gh = new FakeGitHubGateway();
    gh.setBranchProtection("o/r", "main", {
      requiresPullRequestReviews: true, requiredApprovingReviewCount: 1,
      requiredChecks: ["ci"], enforceAdmins: false, requiresConversationResolution: false,
      dismissesStaleReviews: false,
    });
    const first = await gh.getBranchProtection("o/r", "main");
    if (typeof first === "string") throw new Error("expected a summary");
    first.requiredChecks.push("mutated");
    const second = await gh.getBranchProtection("o/r", "main");
    if (typeof second === "string") throw new Error("expected a summary");
    expect(second.requiredChecks).toEqual(["ci"]); // unaffected by the mutation above
  });

  it("setMergeability and setDetailedFiles store copies: mutating the caller's object/array after the call does not corrupt fake state", async () => {
    const gh = new FakeGitHubGateway();
    const m: Mergeability = { state: "clean", mergeable: true, draft: false, baseRef: "main", headSha: "s" };
    gh.setMergeability("o/r", 1, m);
    m.state = "dirty";
    expect((await gh.getMergeability("o/r", 1)).state).toBe("clean");

    const files = [{ filename: "a.ts", status: "added", additions: 1, deletions: 0, patch: undefined }];
    gh.setDetailedFiles("o/r", 1, files);
    files[0].status = "removed";
    expect((await gh.listPullFilesDetailed("o/r", 1))[0].status).toBe("added");
  });

  it("listPullFilesDetailed derives additions/deletions 1/0 from seedPullFiles, and setDetailedFiles overrides it", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPullFiles("o/r", 2, ["a.ts", "b.ts"]);
    expect(await gh.listPullFilesDetailed("o/r", 2)).toEqual([
      { filename: "a.ts", status: "modified", additions: 1, deletions: 0, patch: undefined },
      { filename: "b.ts", status: "modified", additions: 1, deletions: 0, patch: undefined },
    ]);

    gh.setDetailedFiles("o/r", 2, [{ filename: "a.ts", status: "added", additions: 20, deletions: 0, patch: "@@ x @@" }]);
    expect(await gh.listPullFilesDetailed("o/r", 2)).toEqual([
      { filename: "a.ts", status: "added", additions: 20, deletions: 0, patch: "@@ x @@" },
    ]);
  });

  it("listRequestedReviewers defaults to empty users/teams and setRequestedReviewers overrides it", async () => {
    const gh = new FakeGitHubGateway();
    expect(await gh.listRequestedReviewers("o/r", 1)).toEqual({ users: [], teams: [] });
    gh.setRequestedReviewers("o/r", 1, { users: ["alice"], teams: ["backend"] });
    expect(await gh.listRequestedReviewers("o/r", 1)).toEqual({ users: ["alice"], teams: ["backend"] });
  });

  it("getActorType defaults to User and setActorType overrides it", async () => {
    const gh = new FakeGitHubGateway();
    expect(await gh.getActorType("octocat")).toBe("User");
    gh.setActorType("reviewbot", "Bot");
    expect(await gh.getActorType("reviewbot")).toBe("Bot");
    expect(await gh.getActorType("octocat")).toBe("User"); // unaffected
  });

  it("listOpenSecurityAlertCount defaults to 0 and setAlertCount can arrange a count or null", async () => {
    const gh = new FakeGitHubGateway();
    expect(await gh.listOpenSecurityAlertCount("o/r")).toBe(0);
    gh.setAlertCount("o/r", 5);
    expect(await gh.listOpenSecurityAlertCount("o/r")).toBe(5);
    gh.setAlertCount("o/r", null);
    expect(await gh.listOpenSecurityAlertCount("o/r")).toBeNull();
  });

  it("mergePull's sha guard: a mismatched sha fails without merging or recording; a matching sha merges, marks the PR merged, and records it", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 3, title: "t", author: "a", headSha: "currentsha", baseSha: "b", url: "u", state: "open", labels: [] });
    // mergePull consults getMergeability, whose unseeded default now fails, so a test about the sha
    // guard has to say that the pull request is otherwise mergeable.
    gh.setMergeability("o/r", 3, { state: "clean", mergeable: true, draft: false, baseRef: "main", headSha: "currentsha" });

    const mismatched = await gh.mergePull("o/r", 3, { sha: "stalesha" });
    expect(mismatched).toEqual({ merged: false, sha: null, message: "head sha mismatch", reason: "head-moved" });
    expect(gh.merges).toHaveLength(0);
    expect((await gh.getPullRequest("o/r", 3)).state).toBe("open");

    const matched = await gh.mergePull("o/r", 3, { sha: "currentsha", method: "squash", commitTitle: "Squash it" });
    expect(matched).toEqual({ merged: true, sha: "merge-currentsha", message: "merged", reason: null });
    expect(gh.merges).toEqual([{ repo: "o/r", pr: 3, sha: "currentsha", method: "squash", commitTitle: "Squash it" }]);
    const merged = await gh.getPullRequest("o/r", 3);
    expect(merged.state).toBe("merged");
    expect(merged.mergedAt).toBe("2026-01-01T00:00:00Z");
  });

  it("mergePull defaults method to merge when omitted", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 4, title: "t", author: "a", headSha: "s", baseSha: "b", url: "u", state: "open", labels: [] });
    gh.setMergeability("o/r", 4, { state: "clean", mergeable: true, draft: false, baseRef: "main", headSha: "s" });
    await gh.mergePull("o/r", 4, { sha: "s" });
    expect(gh.merges[0]).toMatchObject({ method: "merge" });
  });

  it("mergePull refuses a PR whose arranged mergeability is not clean, or that is not open, even when the sha matches", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 10, title: "t", author: "a", headSha: "s10", baseSha: "b", url: "u", state: "open", labels: [] });
    gh.setMergeability("o/r", 10, { state: "dirty", mergeable: false, draft: false, baseRef: "main", headSha: "s10" });
    const dirty = await gh.mergePull("o/r", 10, { sha: "s10" });
    expect(dirty).toEqual({ merged: false, sha: null, message: "not mergeable", reason: "not-mergeable" });
    expect(gh.merges).toHaveLength(0);

    gh.seedPr({ number: 11, title: "t", author: "a", headSha: "s11", baseSha: "b", url: "u", state: "closed", labels: [] });
    const closed = await gh.mergePull("o/r", 11, { sha: "s11" });
    expect(closed).toEqual({ merged: false, sha: null, message: "not mergeable", reason: "not-mergeable" });
    expect(gh.merges).toHaveLength(0);
  });

  it("getMergeability stops reporting clean once mergePull has merged the PR, even when clean was seeded", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 12, title: "t", author: "a", headSha: "s12", baseSha: "b", url: "u", state: "open", labels: [] });
    gh.setMergeability("o/r", 12, { state: "clean", mergeable: true, draft: false, baseRef: "main", headSha: "s12" });
    expect((await gh.getMergeability("o/r", 12)).state).toBe("clean");

    await gh.mergePull("o/r", 12, { sha: "s12" });
    const after = await gh.getMergeability("o/r", 12);
    expect(after.state).toBe("unknown");
    expect(after.mergeable).toBe(false);
  });

  it('updateBranch defaults to "updated", advances the PR\'s headSha on success (never on conflict), is configurable via setUpdateBranchResult, and records every call', async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 5, title: "t", author: "a", headSha: "sha0", baseSha: "b", url: "u", state: "open", labels: [] });

    expect(await gh.updateBranch("o/r", 5, "expectedsha")).toBe("updated");
    expect((await gh.getPullRequest("o/r", 5)).headSha).toBe("sha0-updated"); // real pulls.updateBranch always creates a new head commit

    gh.setUpdateBranchResult("conflict");
    expect(await gh.updateBranch("o/r", 5)).toBe("conflict");
    expect((await gh.getPullRequest("o/r", 5)).headSha).toBe("sha0-updated"); // unchanged: no new commit on a conflict

    expect(gh.updateBranchCalls).toEqual([
      { repo: "o/r", pr: 5, expectedHeadSha: "expectedsha", previousHeadSha: "sha0" },
      { repo: "o/r", pr: 5, expectedHeadSha: undefined, previousHeadSha: "sha0-updated" },
    ]);
  });

  it("updateBranch tolerates a PR that was never seeded (records the call, reports no previousHeadSha, does not throw)", async () => {
    const gh = new FakeGitHubGateway();
    await expect(gh.updateBranch("o/r", 999)).resolves.toBe("updated");
    expect(gh.updateBranchCalls).toEqual([{ repo: "o/r", pr: 999, expectedHeadSha: undefined, previousHeadSha: undefined }]);
  });

  it("removeLabel removes the label from the PR (no error if absent) and records every call", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 6, title: "t", author: "a", headSha: "s", baseSha: "b", url: "u", state: "open", labels: ["ai-review", "bug"] });

    await gh.removeLabel("o/r", 6, "bug");
    expect((await gh.getPullRequest("o/r", 6)).labels).toEqual(["ai-review"]);

    await expect(gh.removeLabel("o/r", 6, "not-there")).resolves.toBeUndefined(); // no error if absent
    expect(gh.removedLabels).toEqual([
      { repo: "o/r", pr: 6, label: "bug" },
      { repo: "o/r", pr: 6, label: "not-there" },
    ]);
  });

  it("addAssignees records every call", async () => {
    const gh = new FakeGitHubGateway();
    await gh.addAssignees("o/r", 7, ["alice", "bob"]);
    expect(gh.assigneesAdded).toEqual([{ repo: "o/r", pr: 7, assignees: ["alice", "bob"] }]);
  });
});
