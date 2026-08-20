import { describe, it, expect } from "vitest";
import { FakeGitHubGateway } from "../../test/fakes/fake-github.js";
import { expedite } from "./expedite.js";
import { findActionMarkers } from "../expedition/action-marker.js";
import { serializeMeta } from "../review-meta.js";

const REPO = "o/r";
const PR = 1;
const ME = "me"; // FakeGitHubGateway.login: comments and reviews it writes are authored by this login
const HEAD = "sha0001";

// A docs-only pull request that clears every rail except autonomy: green checks, no protection, no
// alerts, no reviewers. Each test below breaks exactly one thing.
function seedGreenDocsPr(): FakeGitHubGateway {
  const gh = new FakeGitHubGateway();
  gh.seedPr({ number: PR, title: "docs: fix a typo", author: "human-author", headSha: HEAD, baseSha: "base", url: "u", state: "open", labels: [] });
  gh.setDetailedFiles(REPO, PR, [{ filename: "README.md", status: "modified", additions: 2, deletions: 1, patch: "@@\n-a\n+b" }]);
  gh.setChecks(REPO, HEAD, [{ name: "build", status: "success" }]);
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
      gh.setBranchProtection(REPO, "main", {
        requiresPullRequestReviews: true, requiredApprovingReviewCount: 1,
        requiredChecks: [], enforceAdmins: false, requiresConversationResolution: false,
      });
      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("proposed");
      expect(result.reasons).toEqual(["branch protection requirements are not satisfied"]);
      expect(gh.merges).toEqual([]);
      expect(gh.reviews).toEqual([]); // and it certainly does not approve anything to get there
    });

    it("merges once a real approval by someone else satisfies that requirement", async () => {
      const gh = seedGreenDocsPr();
      gh.setBranchProtection(REPO, "main", {
        requiresPullRequestReviews: true, requiredApprovingReviewCount: 1,
        requiredChecks: [], enforceAdmins: false, requiresConversationResolution: false,
      });
      gh.login = "peer-bot";
      await gh.submitReview(REPO, PR, { commitId: HEAD, event: "APPROVE", body: "fine by me" });
      gh.login = ME;
      const result = await run(gh, { autonomy: "auto", knownAgentLogins: ["peer-bot"] });
      expect(result.action).toBe("merged");
    });

    it("judges only the required contexts when the base branch declares them", async () => {
      const gh = seedGreenDocsPr();
      gh.setBranchProtection(REPO, "main", {
        requiresPullRequestReviews: false, requiredApprovingReviewCount: 0,
        requiredChecks: ["build"], enforceAdmins: false, requiresConversationResolution: false,
      });
      gh.setChecks(REPO, HEAD, [{ name: "build", status: "success" }, { name: "optional-perf", status: "failure" }]);
      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("merged"); // the failing check is not required, so it does not block
    });

    it("holds off when a human has an open review request", async () => {
      const gh = seedGreenDocsPr();
      gh.setRequestedReviewers(REPO, PR, { users: ["alice"], teams: [] });
      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("proposed");
      expect(result.reasons.some((r) => r.includes("human review"))).toBe(true);
    });

    it("holds off when a team has an open review request, whose members it cannot enumerate", async () => {
      const gh = seedGreenDocsPr();
      gh.setRequestedReviewers(REPO, PR, { users: [], teams: ["backend"] });
      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("proposed");
      expect(result.reasons.some((r) => r.includes("human review"))).toBe(true);
    });

    it("does not treat a known peer agent's review as a human in flight", async () => {
      const gh = seedGreenDocsPr();
      gh.login = "peer-bot";
      await gh.submitReview(REPO, PR, { commitId: HEAD, event: "COMMENT", body: `looked at it\n\n${serializeMeta({ v: 1, role: "second-opinion", verdict: "comment" })}` });
      gh.login = ME;
      const result = await run(gh, { autonomy: "auto", knownAgentLogins: ["peer-bot"] });
      expect(result.action).toBe("merged");
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

      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("blocked");
      expect(result.reasons).toHaveLength(1);
      expect(result.reasons[0]).toContain("head-moved");
      expect(gh.merges).toEqual([]); // nothing landed
    });
  });
});
