import { describe, it, expect } from "vitest";
import { FakeGitHubGateway } from "../../test/fakes/fake-github.js";
import { expedite } from "./expedite.js";
import { findActionMarkers } from "../expedition/action-marker.js";
import { serializeMeta } from "../review-meta.js";
import type { BranchProtectionSummary } from "../github.js";

const REPO = "o/r";
const PR = 1;
const ME = "me"; // FakeGitHubGateway.login: comments and reviews it writes are authored by this login
const HEAD = "sha0001";

/** Branch protection with nothing set but what a test names. */
const protection = (over: Partial<BranchProtectionSummary> = {}): BranchProtectionSummary => ({
  requiresPullRequestReviews: false,
  requiredApprovingReviewCount: 0,
  requiredChecks: [],
  enforceAdmins: false,
  requiresConversationResolution: false,
  dismissesStaleReviews: false,
  ...over,
});

/** Protection requiring one approving review, with GitHub's own state while that review is missing. */
function seedProtectedAwaitingReview(gh: FakeGitHubGateway, over: Partial<BranchProtectionSummary> = {}): void {
  gh.setBranchProtection(REPO, "main", protection({ requiresPullRequestReviews: true, requiredApprovingReviewCount: 1, ...over }));
  gh.setMergeability(REPO, PR, { state: "blocked", mergeable: false, draft: false, baseRef: "main", headSha: HEAD });
}

/** A review by `author`, recorded under that login exactly as GitHub records it. */
async function reviewAs(gh: FakeGitHubGateway, author: string, event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT", commitId = HEAD, body = "looks fine") {
  const previous = gh.login;
  gh.login = author;
  try {
    await gh.submitReview(REPO, PR, { commitId, event, body });
  } finally {
    gh.login = previous;
  }
}

// A docs-only pull request that clears every rail except autonomy: green checks, no protection, no
// alerts, no reviewers. Each test below breaks exactly one thing.
//
// The mergeable state is seeded explicitly, as it has to be everywhere: the fake's unseeded default
// is "unknown", which fails rail 4, precisely so no test can assert a state combination GitHub cannot
// produce. "clean" is the honest one here because this pull request's base branch has no protection.
function seedGreenDocsPr(): FakeGitHubGateway {
  const gh = new FakeGitHubGateway();
  gh.seedPr({ number: PR, title: "docs: fix a typo", author: "human-author", headSha: HEAD, baseSha: "base", url: "u", state: "open", labels: [] });
  gh.setDetailedFiles(REPO, PR, [{ filename: "README.md", status: "modified", additions: 2, deletions: 1, patch: "@@\n-a\n+b" }]);
  gh.setChecks(REPO, HEAD, [{ name: "build", status: "success" }]);
  gh.setAlertCount(REPO, 0);
  gh.setMergeability(REPO, PR, { state: "clean", mergeable: true, draft: false, baseRef: "main", headSha: HEAD });
  return gh;
}

const run = (gh: FakeGitHubGateway, over: Partial<Parameters<typeof expedite>[1]> = {}) =>
  expedite(gh, { repo: REPO, pr: PR, actingLogin: ME, now: "2026-08-07T10:00:00Z", ...over });

describe("expedite", () => {
  describe("propose mode (the default)", () => {
    it("posts one proposal carrying the marker, and merges nothing", async () => {
      const gh = seedGreenDocsPr();
      const result = await run(gh);
      expect(result.action).toBe("proposed");
      expect(result.headSha).toBe(HEAD);
      expect(result.reasons).toEqual(['autonomy is "propose", not "auto"']);
      expect(gh.merges).toEqual([]);

      const comments = await gh.listComments(REPO, PR);
      expect(comments).toHaveLength(1);
      expect(comments[0].body).toContain("merge this pull request");
      expect(comments[0].body).toContain(HEAD);
      expect(findActionMarkers(comments)[0].marker).toEqual({
        v: 1, kind: "expedite-proposal", headSha: HEAD, decision: "propose", at: "2026-08-07T10:00:00Z",
      });
    });

    it("an omitted autonomy is propose, never auto, on an otherwise perfectly mergeable pull request", async () => {
      const gh = seedGreenDocsPr();
      expect((await run(gh)).action).toBe("proposed");
      expect(gh.merges).toEqual([]);
      expect(gh.reviews).toEqual([]);
    });

    it("a second run at the same head reports already-proposed and posts no duplicate", async () => {
      const gh = seedGreenDocsPr();
      await run(gh);
      const first = (await gh.listComments(REPO, PR))[0];

      const second = await run(gh, { now: "2026-08-07T11:00:00Z" });
      expect(second.action).toBe("already-proposed");
      expect(second.reasons).toEqual(['autonomy is "propose", not "auto"']);
      const comments = await gh.listComments(REPO, PR);
      expect(comments).toHaveLength(1);
      expect(comments[0].id).toBe(first.id); // the same comment, untouched
    });

    it("a new head deletes the stale proposal and posts a fresh one", async () => {
      const gh = seedGreenDocsPr();
      await run(gh);
      const stale = (await gh.listComments(REPO, PR))[0];

      gh.prs.get(`${REPO}#${PR}`)!.headSha = "sha0002"; // the author pushed
      gh.setChecks(REPO, "sha0002", [{ name: "build", status: "success" }]);
      const result = await run(gh, { now: "2026-08-07T12:00:00Z" });

      expect(result.action).toBe("proposed");
      expect(result.headSha).toBe("sha0002");
      const comments = await gh.listComments(REPO, PR);
      expect(comments).toHaveLength(1); // exactly one live proposal, describing the current head
      expect(comments[0].id).not.toBe(stale.id);
      expect(findActionMarkers(comments)[0].marker.headSha).toBe("sha0002");
    });

    it("ignores a marker in someone else's comment when deciding whether it has proposed", async () => {
      const gh = seedGreenDocsPr();
      gh.login = "someone-else";
      await run(gh, { actingLogin: "someone-else" }); // another actor's proposal at this same head
      gh.login = ME;

      const result = await run(gh);
      expect(result.action).toBe("proposed"); // not silenced by a proposal this agent did not write
      const comments = await gh.listComments(REPO, PR);
      expect(comments).toHaveLength(2);
      expect(comments.map((c) => c.author)).toEqual(["someone-else", ME]); // and it deleted nothing of theirs
    });
  });

  describe("not eligible", () => {
    it.each(["closed", "merged"] as const)("refuses a %s pull request without commenting", async (state) => {
      const gh = seedGreenDocsPr();
      gh.prs.get(`${REPO}#${PR}`)!.state = state;
      const result = await run(gh);
      expect(result.action).toBe("not-eligible");
      expect(result.reasons[0]).toContain(state);
      expect(await gh.listComments(REPO, PR)).toEqual([]);
    });

    it("refuses a draft before the gate ever sees it", async () => {
      const gh = seedGreenDocsPr();
      gh.setMergeability(REPO, PR, { state: "draft", mergeable: null, draft: true, baseRef: "main", headSha: HEAD });
      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("not-eligible");
      expect(result.reasons[0]).toContain("draft");
      expect(gh.merges).toEqual([]);
      expect(await gh.listComments(REPO, PR)).toEqual([]);
    });
  });

  describe("rails reported in the proposal", () => {
    it("names a source path that disqualifies the change", async () => {
      const gh = seedGreenDocsPr();
      gh.setDetailedFiles(REPO, PR, [{ filename: "core/index.ts", status: "modified", additions: 1, deletions: 1, patch: "@@" }]);
      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("proposed");
      expect(result.reasons.some((r) => r.includes("core/index.ts"))).toBe(true);
    });

    it("distinguishes open security alerts from an unreadable alert API", async () => {
      const withAlerts = seedGreenDocsPr();
      withAlerts.setAlertCount(REPO, 2);
      const alerted = await run(withAlerts, { autonomy: "auto" });
      expect(alerted.reasons.some((r) => r.includes("2 open security alert"))).toBe(true);

      const noAccess = seedGreenDocsPr();
      noAccess.setAlertCount(REPO, null);
      const unknown = await run(noAccess, { autonomy: "auto" });
      expect(unknown.reasons.some((r) => r.includes("unknown") && r.includes("failing closed"))).toBe(true);
    });

    it("fails closed when branch protection cannot be read", async () => {
      const gh = seedGreenDocsPr();
      gh.setBranchProtection(REPO, "main", "unknown");
      const result = await run(gh, { autonomy: "auto" });
      expect(result.reasons.some((r) => r.includes("branch protection"))).toBe(true);
    });

    // The other side of the issue #48 fix: a required approval is only ever counted for the
    // operation that is about to SUPPLY it. expedite merges rather than approves, so it passes no
    // willApproveAs to gatherRails and rail 5 is exactly what it always was: a missing required
    // approval holds the change back, even under autonomy auto, even from an agent that could
    // approve some other pull request.
    it("still fails the protection rail on a repository that requires an approving review", async () => {
      const gh = seedGreenDocsPr();
      gh.setBranchProtection(REPO, "main", protection({ requiresPullRequestReviews: true, requiredApprovingReviewCount: 1 }));
      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("proposed");
      expect(result.reasons).toEqual(["branch protection requirements are not satisfied"]);
      expect(gh.merges).toEqual([]);
      expect(gh.reviews).toEqual([]); // and it certainly does not approve anything to get there
    });

    // The rail 4 half of the same rule. GitHub reports "blocked" while a required review is missing,
    // and the approver's allowance to tolerate that is exactly what expedite must not have: it merges
    // rather than approves, so nothing it does would remove the block.
    it("still refuses a blocked mergeable state, which it can never be the one to clear", async () => {
      const gh = seedGreenDocsPr();
      seedProtectedAwaitingReview(gh);

      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("proposed");
      expect(result.reasons).toContain("mergeable state is blocked (need clean)");
      expect(result.reasons).toContain("branch protection requirements are not satisfied");
      expect(gh.merges).toEqual([]);
      expect(gh.reviews).toEqual([]);
    });

    it.each(["dirty", "unstable", "unknown"] as const)("still refuses a %s mergeable state", async (state) => {
      const gh = seedGreenDocsPr();
      gh.setMergeability(REPO, PR, { state, mergeable: false, draft: false, baseRef: "main", headSha: HEAD });
      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("proposed");
      expect(result.reasons).toEqual([`mergeable state is ${state} (need clean)`]);
      expect(gh.merges).toEqual([]);
    });

    it("judges only the required contexts when the base branch declares them", async () => {
      const gh = seedGreenDocsPr();
      gh.setBranchProtection(REPO, "main", protection({ requiredChecks: ["build"] }));
      gh.setChecks(REPO, HEAD, [{ name: "build", status: "success" }, { name: "optional-perf", status: "failure" }]);
      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("merged"); // the failing check is not required, so it does not block
    });

    it("reads protection for the pull request's OWN base ref, not an assumed default branch", async () => {
      const gh = seedGreenDocsPr();
      gh.setMergeability(REPO, PR, { state: "clean", mergeable: true, draft: false, baseRef: "release/1.x", headSha: HEAD });
      gh.setBranchProtection(REPO, "release/1.x", "unknown"); // unreadable on the real base
      gh.setBranchProtection(REPO, "main", "none");           // wide open on the branch it must NOT consult
      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("proposed");
      expect(result.reasons.some((r) => r.includes("branch protection"))).toBe(true);
      expect(gh.merges).toEqual([]);
    });

    it("refuses when the head moves while the rails are being gathered", async () => {
      // The push lands before the gather's closing re-read, so rail 9 catches it and nothing is
      // merged: the rails describe a commit that is no longer the one an action would apply to.
      class HeadMovesDuringGather extends FakeGitHubGateway {
        private reads = 0;
        async getPullRequest(repo: string, pr: number) {
          if (++this.reads === 2) this.prs.get(`${repo}#${pr}`)!.headSha = "sha0002";
          return super.getPullRequest(repo, pr);
        }
      }
      const gh = new HeadMovesDuringGather();
      gh.seedPr({ number: PR, title: "docs", author: "human-author", headSha: HEAD, baseSha: "base", url: "u", state: "open", labels: [] });
      gh.setDetailedFiles(REPO, PR, [{ filename: "README.md", status: "modified", additions: 1, deletions: 1, patch: "@@" }]);
      gh.setChecks(REPO, HEAD, [{ name: "build", status: "success" }]);

      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("proposed");
      expect(result.reasons.some((r) => r.includes("head SHA guard"))).toBe(true);
      expect(result.headSha).toBe(HEAD); // still reports the head it evaluated
      expect(gh.merges).toEqual([]);
    });

    it("respects a tighter size policy", async () => {
      const gh = seedGreenDocsPr();
      const result = await run(gh, { autonomy: "auto", policy: { maxLines: 1 } });
      expect(result.action).toBe("proposed");
      expect(result.reasons.some((r) => r.includes("too many changed lines"))).toBe(true);
    });
  });

  // Issue #57, the verified repro, row by row. The pull request is identical in every row: docs only,
  // green checks, a clean mergeable state, protection requiring one approving review, autonomy auto,
  // and exactly one approval present. Only the approver's identity differed, and it used to decide
  // everything, because the approval that satisfied rail 5 was the same event that failed rail 7 and a
  // GitHub review is permanent history: the human row could never merge on any later tick either.
  describe("the one approval that satisfies protection (issue #57)", () => {
    async function approvedBy(approver: string, over: Partial<Parameters<typeof expedite>[1]> = {}) {
      const gh = seedGreenDocsPr();
      gh.setBranchProtection(REPO, "main", protection({ requiresPullRequestReviews: true, requiredApprovingReviewCount: 1 }));
      await reviewAs(gh, approver, "APPROVE");
      return { gh, result: await run(gh, { autonomy: "auto", ...over }) };
    }

    it("merges on a HUMAN maintainer's approval: the normal case, and the whole deadlock", async () => {
      const { gh, result } = await approvedBy("alice");
      expect(result).toEqual({ action: "merged", reasons: [], headSha: HEAD });
      expect(gh.merges).toEqual([{ repo: REPO, pr: PR, sha: HEAD, method: "merge", commitTitle: undefined }]);
      expect(await gh.listComments(REPO, PR)).toEqual([]); // no proposal: nothing held it back
    });

    it("merges on a peer agent's approval whether or not the caller listed the login", async () => {
      // knownAgentLogins used to be the difference between merging and proposing on this exact state.
      // It no longer decides this rail at all, so a peer agent the operator forgot to configure is no
      // longer a permanent obstacle either.
      expect((await approvedBy("peer-bot", { knownAgentLogins: ["peer-bot"] })).result.action).toBe("merged");
      expect((await approvedBy("peer-bot")).result.action).toBe("merged");
    });

    it("still holds off while a human's review request is outstanding: that IS a review in flight", async () => {
      const gh = seedGreenDocsPr();
      gh.setRequestedReviewers(REPO, PR, { users: ["alice"], teams: [] });
      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("proposed");
      expect(result.reasons).toEqual(["a human review is in flight"]);
      expect(gh.merges).toEqual([]);
    });

    it("still holds off for a requested team, whose members it cannot enumerate", async () => {
      const gh = seedGreenDocsPr();
      gh.setRequestedReviewers(REPO, PR, { users: [], teams: ["backend"] });
      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("proposed");
      expect(result.reasons).toEqual(["a human review is in flight"]);
      expect(gh.merges).toEqual([]);
    });

    // Unprotected on purpose, so rail 7 is the only rail that can refuse: on a branch that requires no
    // review, GitHub really does report "clean" with a CHANGES_REQUESTED review outstanding.
    it("holds off on a human's standing CHANGES_REQUESTED, with its own reason rather than a claim of a race", async () => {
      const gh = seedGreenDocsPr();
      await reviewAs(gh, "alice", "REQUEST_CHANGES", HEAD, "not like this");
      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("proposed");
      expect(result.reasons).toEqual(["a human has requested changes"]);
      expect(gh.merges).toEqual([]);
      // The maintainer reads this comment: it must not tell them somebody is mid-review.
      expect((await gh.listComments(REPO, PR))[0].body).toContain("a human has requested changes");
      expect((await gh.listComments(REPO, PR))[0].body).not.toContain("in flight");
    });

    it("merges once that same human replaces the refusal with an approval", async () => {
      const gh = seedGreenDocsPr();
      await reviewAs(gh, "alice", "REQUEST_CHANGES", HEAD, "not like this");
      await reviewAs(gh, "alice", "APPROVE", HEAD, "better now"); // the latest verdict wins
      expect((await run(gh, { autonomy: "auto" })).action).toBe("merged");
    });

    it("does not hold off for a comment-only review, by a human or by a known agent", async () => {
      const human = seedGreenDocsPr();
      await reviewAs(human, "alice", "COMMENT", HEAD, "drive-by note");
      expect((await run(human, { autonomy: "auto" })).action).toBe("merged");

      const agent = seedGreenDocsPr();
      await reviewAs(agent, "peer-bot", "COMMENT", HEAD, `looked at it\n\n${serializeMeta({ v: 1, role: "second-opinion", verdict: "comment" })}`);
      expect((await run(agent, { autonomy: "auto", knownAgentLogins: ["peer-bot"] })).action).toBe("merged");
    });

    // The regression guard for the bug itself: a standing approval must never again be read as
    // anything a rail can refuse. Stated over every login it could come from, so no future change can
    // quietly restore the conflation for one of them, and asserted on the ACTION as well as on the
    // wording, so re-labelling the old boolean as some other kind of human obstacle fails here too.
    it.each(["alice", "peer-bot", ME])("never treats a standing approval by %s as an obstacle", async (approver) => {
      const { gh, result } = await approvedBy(approver);
      expect(result.action).toBe("merged");
      expect(result.reasons).toEqual([]);
      expect(result.reasons.some((r) => r.includes("human") || r.includes("in flight"))).toBe(false);
      expect(gh.merges).toHaveLength(1);
    });
  });

  // Issue #53: a peer approved sha0001, the author pushed sha0009, and the gate merged sha0009 on the
  // strength of the approval of sha0001. Nobody had approved the code that merged.
  describe("an approval of a commit that is no longer the head (issue #53)", () => {
    const PUSHED = "sha0009";

    /** The repro: an approval at HEAD, then a push to PUSHED with the checks green there too. */
    async function approvedThenPushed(over: Partial<Parameters<typeof expedite>[1]> = {}, protectionOver: Partial<BranchProtectionSummary> = {}) {
      const gh = seedGreenDocsPr();
      gh.setBranchProtection(REPO, "main", protection({
        requiresPullRequestReviews: true, requiredApprovingReviewCount: 1, ...protectionOver,
      }));
      await reviewAs(gh, "peer-bot", "APPROVE");
      gh.prs.get(`${REPO}#${PR}`)!.headSha = PUSHED;
      gh.setChecks(REPO, PUSHED, [{ name: "build", status: "success" }]);
      gh.setMergeability(REPO, PR, { state: "clean", mergeable: true, draft: false, baseRef: "main", headSha: PUSHED });
      return { gh, result: await run(gh, { autonomy: "auto", knownAgentLogins: ["peer-bot"], ...over }) };
    }

    it("does not satisfy the required-approvals rule, so the change proposes instead of merging", async () => {
      const { gh, result } = await approvedThenPushed();
      expect(result.action).toBe("proposed");
      expect(result.reasons).toEqual(["branch protection requirements are not satisfied"]);
      expect(result.headSha).toBe(PUSHED);
      expect(gh.merges).toEqual([]); // the commit nobody approved is not merged
    });

    it("does not block either: nobody approved this code, and nobody is mid-review", async () => {
      const { result } = await approvedThenPushed();
      expect(result.reasons.some((r) => r.includes("human"))).toBe(false);
    });

    it("counts again on a branch that dismisses stale reviews, where GitHub retires them itself", async () => {
      const { gh, result } = await approvedThenPushed({}, { dismissesStaleReviews: true });
      expect(result.action).toBe("merged");
      expect(gh.merges).toEqual([{ repo: REPO, pr: PR, sha: PUSHED, method: "merge", commitTitle: undefined }]);
    });

    it("merges once someone approves the commit that would actually merge", async () => {
      const { gh } = await approvedThenPushed();
      await reviewAs(gh, "peer-bot", "APPROVE", PUSHED, "checked the new head too");
      const second = await run(gh, { autonomy: "auto", knownAgentLogins: ["peer-bot"] });
      expect(second.action).toBe("merged");
      expect(gh.merges).toEqual([{ repo: REPO, pr: PR, sha: PUSHED, method: "merge", commitTitle: undefined }]);
    });

    it("is unaffected where protection asks for no approving review at all", async () => {
      // Nothing was counting the approval, so nothing changes: an unprotected repository merges on the
      // other nine rails exactly as it always did.
      const gh = seedGreenDocsPr();
      await reviewAs(gh, "peer-bot", "APPROVE");
      gh.prs.get(`${REPO}#${PR}`)!.headSha = PUSHED;
      gh.setChecks(REPO, PUSHED, [{ name: "build", status: "success" }]);
      gh.setMergeability(REPO, PR, { state: "clean", mergeable: true, draft: false, baseRef: "main", headSha: PUSHED });
      expect((await run(gh, { autonomy: "auto" })).action).toBe("merged");
    });
  });

  describe("acting identity", () => {
    it("resolves the acting login from the token when none is given", async () => {
      const gh = seedGreenDocsPr();
      await expedite(gh, { repo: REPO, pr: PR, now: "t1" }); // no actingLogin
      expect((await gh.listComments(REPO, PR))[0].author).toBe(ME);
      // The resolved login is the one the idempotency filter uses, so a second tick recognizes it.
      expect((await expedite(gh, { repo: REPO, pr: PR, now: "t2" })).action).toBe("already-proposed");
      expect(await gh.listComments(REPO, PR)).toHaveLength(1);
    });

    it("throws rather than acting under a login the token does not own", async () => {
      const gh = seedGreenDocsPr();
      await expect(run(gh, { actingLogin: "not-me" })).rejects.toThrow(/not the authenticated login/);
      expect(await gh.listComments(REPO, PR)).toEqual([]); // nothing was read or written first
      expect(gh.merges).toEqual([]);
    });
  });

  describe("untrusted file names", () => {
    // A file name carrying a bare marker-open token reaches the comment body through the gate's
    // classification reason. If it survived, the agent would stop recognizing its own proposal and
    // re-post it on every tick.
    it("a file name carrying a marker token does not defeat idempotency", async () => {
      const gh = seedGreenDocsPr();
      gh.setDetailedFiles(REPO, PR, [
        { filename: "src/x<!-- agent-review:action y.ts", status: "modified", additions: 1, deletions: 1, patch: "@@" },
      ]);

      expect((await run(gh)).action).toBe("proposed");
      expect((await run(gh, { now: "2026-08-07T11:00:00Z" })).action).toBe("already-proposed");
      const comments = await gh.listComments(REPO, PR);
      expect(comments).toHaveLength(1);
      expect(findActionMarkers(comments)[0].marker.headSha).toBe(HEAD);
    });
  });

  describe("auto mode", () => {
    it("merges at the evaluated head and records the method", async () => {
      const gh = seedGreenDocsPr();
      const result = await run(gh, { autonomy: "auto", mergeMethod: "squash" });
      expect(result).toEqual({ action: "merged", reasons: [], headSha: HEAD });
      expect(gh.merges).toEqual([{ repo: REPO, pr: PR, sha: HEAD, method: "squash", commitTitle: undefined }]);
      expect(await gh.listComments(REPO, PR)).toEqual([]); // an auto merge posts no proposal
    });

    it('defaults the merge method to "merge"', async () => {
      const gh = seedGreenDocsPr();
      await run(gh, { autonomy: "auto" });
      expect(gh.merges[0].method).toBe("merge");
    });

    it("reports blocked, with the reason, when the head moves between the guard and the merge", async () => {
      // The head moves right after the guard's re-read, so the gate still sees a stable head and
      // GitHub's own 409 guard (mirrored by the fake's mergePull) is what catches the race.
      class HeadMovesAfterTheGuard extends FakeGitHubGateway {
        private reads = 0;
        async getPullRequest(repo: string, pr: number) {
          const snapshot = await super.getPullRequest(repo, pr);
          if (++this.reads === 2) this.prs.get(`${repo}#${pr}`)!.headSha = "sha0002";
          return snapshot;
        }
      }
      const gh = new HeadMovesAfterTheGuard();
      gh.seedPr({ number: PR, title: "docs", author: "human-author", headSha: HEAD, baseSha: "base", url: "u", state: "open", labels: [] });
      gh.setDetailedFiles(REPO, PR, [{ filename: "README.md", status: "modified", additions: 1, deletions: 1, patch: "@@" }]);
      gh.setChecks(REPO, HEAD, [{ name: "build", status: "success" }]);
      gh.setAlertCount(REPO, 0);
      gh.setMergeability(REPO, PR, { state: "clean", mergeable: true, draft: false, baseRef: "main", headSha: HEAD });

      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("blocked");
      expect(result.reasons).toHaveLength(1);
      expect(result.reasons[0]).toContain("head-moved");
      expect(gh.merges).toEqual([]); // nothing landed
    });
  });
});
