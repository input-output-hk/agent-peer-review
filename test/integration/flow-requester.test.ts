// Flow A (pr-requester) end to end, at the operation level: the tick sequences the flow's
// instructions.md tells its executor to run, over the real operations, against the fake gateway.
//
// The unit tests next to each operation prove one decision at a time. These prove the SEQUENCE: a
// flow calls stabilize, then expedite, then requestPeerReview, every tick, forever, and what has to
// hold is that the durable state on the pull request converges instead of accumulating. So each tick
// below asserts the state a maintainer would see (comments, markers, labels, review requests,
// merges), not just the value the operation returned.
//
// Deterministic by construction: `tick(n)` supplies the only timestamps, and no assertion reads a
// clock.

import { describe, it, expect } from "vitest";
import { FakeGitHubGateway } from "../fakes/fake-github.js";
import { stabilize } from "../../core/operations/stabilize.js";
import { expedite } from "../../core/operations/expedite.js";
import { requestPeerReview } from "../../core/operations/request-peer-review.js";
import { findActionMarkers } from "../../core/expedition/action-marker.js";
import { TRIGGER } from "../../core/labels.js";
import type { DetailedPullFile } from "../../core/github.js";

const REPO = "o/r";
const PR = 1;
const ME = "me"; // FakeGitHubGateway.login: every comment and review it records is authored by this login
const PEER = "peer-agent";
const AUTHOR = "human-author";
const HEAD = "sha0001";
/** The head the fake's updateBranch creates, mirroring pulls.updateBranch's new merge commit. */
const SYNCED = `${HEAD}-updated`;
const PUSHED = "sha0003";

/** The flow's tick clock. One fixed ISO timestamp per tick, and the only source of "now" here. */
const tick = (n: number): string => `2026-08-08T${String(9 + n).padStart(2, "0")}:00:00Z`;

const DOCS_FILE: DetailedPullFile = { filename: "README.md", status: "modified", additions: 2, deletions: 1, patch: "@@\n-a\n+b" };
const SOURCE_FILE: DetailedPullFile = { filename: "core/thing.ts", status: "modified", additions: 4, deletions: 2, patch: "@@\n-a\n+b" };

/** An open pull request of this account's own, with green checks at `headSha` and nothing else set. */
function seedPr(gh: FakeGitHubGateway, headSha: string, files: DetailedPullFile[] = [DOCS_FILE]): void {
  gh.seedPr({ number: PR, title: "docs: fix a typo", author: AUTHOR, headSha, baseSha: "base", url: "u", state: "open", labels: [] });
  gh.setDetailedFiles(REPO, PR, files);
  gh.setChecks(REPO, headSha, [{ name: "build", status: "success" }]);
}

/**
 * GitHub's own view of a branch that is in sync at `headSha`: clean, mergeable, green.
 *
 * Arranged explicitly after every head change because the fake stores mergeability per pull request,
 * not per commit, so a stale entry would keep describing the previous head. This is also what GitHub
 * really reports once a base sync lands, which is what the next operation in the tick reads.
 */
function seedClean(gh: FakeGitHubGateway, headSha: string): void {
  gh.setMergeability(REPO, PR, { state: "clean", mergeable: true, draft: false, baseRef: "main", headSha });
  gh.setChecks(REPO, headSha, [{ name: "build", status: "success" }]);
}

/** An author push: a new head commit, with its own green checks and a clean mergeable state. */
function push(gh: FakeGitHubGateway, headSha: string): void {
  gh.prs.get(`${REPO}#${PR}`)!.headSha = headSha;
  seedClean(gh, headSha);
}

const runExpedite = (gh: FakeGitHubGateway, now: string, over: Partial<Parameters<typeof expedite>[1]> = {}) =>
  expedite(gh, { repo: REPO, pr: PR, actingLogin: ME, now, ...over });

/** The single action marker on the pull request. Fails loudly if there is not exactly one. */
async function soleMarker(gh: FakeGitHubGateway) {
  const comments = await gh.listComments(REPO, PR);
  const markers = findActionMarkers(comments);
  expect(markers).toHaveLength(1);
  return { comment: markers[0].comment, marker: markers[0].marker };
}

describe("Flow A (pr-requester): stabilize, expedite, request a peer review", () => {
  describe("docs-only pull request, propose mode", () => {
    it("converges on exactly one live proposal across a sync, a no-op tick, and a push", async () => {
      const gh = new FakeGitHubGateway();
      seedPr(gh, HEAD);
      gh.setMergeability(REPO, PR, { state: "behind", mergeable: false, draft: false, baseRef: "main", headSha: HEAD });

      // -- Tick 1: the branch is behind, so step 1 syncs it and step 2 evaluates the NEW head.
      const sync = await stabilize(gh, { repo: REPO, pr: PR });
      expect(sync.status).toBe("updated");
      // The sync pinned the head it read in this same tick, and produced a new head commit.
      expect(gh.updateBranchCalls).toEqual([{ repo: REPO, pr: PR, expectedHeadSha: HEAD, previousHeadSha: HEAD }]);
      expect((await gh.getPullRequest(REPO, PR)).headSha).toBe(SYNCED);
      seedClean(gh, SYNCED);

      const first = await runExpedite(gh, tick(1));
      expect(first.action).toBe("proposed");
      expect(first.headSha).toBe(SYNCED); // the proposal describes the synced commit, not the pre-sync one
      const proposal = await soleMarker(gh);
      expect(proposal.marker).toEqual({ v: 1, kind: "expedite-proposal", headSha: SYNCED, decision: "propose", at: tick(1) });
      expect(proposal.comment.author).toBe(ME);
      expect(proposal.comment.body).toContain("merge this pull request");
      expect(gh.merges).toEqual([]); // propose mode merges nothing, ever

      // -- Tick 2: nothing changed. Both steps must be no-ops on the pull request.
      expect((await stabilize(gh, { repo: REPO, pr: PR })).status).toBe("up-to-date");
      expect((await runExpedite(gh, tick(2))).action).toBe("already-proposed");
      const unchanged = await soleMarker(gh);
      expect(unchanged.comment.id).toBe(proposal.comment.id); // the same comment
      expect(unchanged.marker.at).toBe(tick(1));              // untouched, not re-posted with a new timestamp
      expect(gh.updateBranchCalls).toHaveLength(1);           // and nothing was pushed to the branch

      // -- Tick 3: the author pushed. The stale proposal must go, and exactly one must remain.
      push(gh, PUSHED);
      expect((await stabilize(gh, { repo: REPO, pr: PR })).status).toBe("up-to-date");
      const third = await runExpedite(gh, tick(3));
      expect(third.action).toBe("proposed");
      const fresh = await soleMarker(gh);
      expect(fresh.comment.id).not.toBe(proposal.comment.id);
      expect(fresh.marker).toMatchObject({ headSha: PUSHED, at: tick(3) });
      expect(await gh.listComments(REPO, PR)).toHaveLength(1); // one live proposal, not a thread of them
      expect(gh.merges).toEqual([]);
    });
  });

  describe("docs-only pull request, autonomy auto", () => {
    it("merges once, then reports the pull request finished on the next tick", async () => {
      const gh = new FakeGitHubGateway();
      seedPr(gh, HEAD);
      seedClean(gh, HEAD);

      // -- Tick 1
      expect((await stabilize(gh, { repo: REPO, pr: PR })).status).toBe("up-to-date");
      const merged = await runExpedite(gh, tick(1), { autonomy: "auto" });
      expect(merged).toEqual({ action: "merged", reasons: [], headSha: HEAD });
      expect(gh.merges).toEqual([{ repo: REPO, pr: PR, sha: HEAD, method: "merge", commitTitle: undefined }]);
      expect((await gh.getPullRequest(REPO, PR)).state).toBe("merged");
      expect(await gh.listComments(REPO, PR)).toEqual([]); // a merge explains itself; no proposal is posted

      // -- Tick 2: the flow runs again on a pull request it already merged. Both steps must refuse,
      // and the refusals must be distinguishable: "gone" is terminal, and nothing is re-merged.
      const after = await stabilize(gh, { repo: REPO, pr: PR });
      expect(after.status).toBe("gone");
      expect(after.detail).toContain("merged");
      const again = await runExpedite(gh, tick(2), { autonomy: "auto" });
      expect(again.action).toBe("not-eligible");
      expect(again.reasons[0]).toContain("merged");
      expect(gh.merges).toHaveLength(1); // still exactly one merge
      expect(await gh.listComments(REPO, PR)).toEqual([]);
    });
  });

  describe("pull request carrying real code", () => {
    it("proposes with the classification reason, then hands the change to a peer exactly once", async () => {
      const gh = new FakeGitHubGateway();
      seedPr(gh, HEAD, [DOCS_FILE, SOURCE_FILE]);
      seedClean(gh, HEAD);

      // -- Tick 1: step 2 cannot merge code, and says which path disqualified it. That reason is
      // what step 3 keys on when it decides to request a peer review.
      expect((await stabilize(gh, { repo: REPO, pr: PR })).status).toBe("up-to-date");
      const proposed = await runExpedite(gh, tick(1), { autonomy: "auto" });
      expect(proposed.action).toBe("proposed"); // autonomy auto does not override the classification rail
      const classification = proposed.reasons.find((r) => r.startsWith("not auto-eligible:"));
      expect(classification).toBeDefined();
      expect(classification).toContain("source");
      expect(classification).toContain("core/thing.ts");
      expect(gh.merges).toEqual([]);

      const requested = await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: [PEER] });
      expect(requested).toEqual({ status: "requested", reviewers: [PEER] });
      expect((await gh.getPullRequest(REPO, PR)).labels).toEqual([TRIGGER]);
      expect(await gh.listRequestedReviewers(REPO, PR)).toEqual({ users: [PEER], teams: [] });

      // -- Tick 2: the same pull request, still at the same head. Neither step may duplicate its
      // earlier work, and the standing request must be recognized rather than re-made.
      const second = await runExpedite(gh, tick(2), { autonomy: "auto" });
      expect(second.action).toBe("already-proposed");
      // The peer's open request now trips the human-review rail, which is correct and changes
      // nothing about the standing proposal: postProposal keys on the head commit.
      expect(second.reasons.some((r) => r.includes("human review"))).toBe(true);
      const still = await soleMarker(gh);
      expect(still.marker.at).toBe(tick(1));

      expect(await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: [PEER] }))
        .toEqual({ status: "already-requested", reviewers: [PEER] });
      expect((await gh.getPullRequest(REPO, PR)).labels).toEqual([TRIGGER]); // no duplicate label
      expect(await gh.listRequestedReviewers(REPO, PR)).toEqual({ users: [PEER], teams: [] }); // no second request
      expect(gh.merges).toEqual([]);
    });
  });

  // Issue #52, livelock 1: this flow calls requestPeerReview every tick, and the peer's flow reviews
  // whatever it is asked to. Keyed on an OPEN request alone, the tick after the peer answered saw a
  // labeled pull request with no outstanding request and asked again, because submitting a review
  // clears the request natively. That cost one full agent invocation per tick, per pull request,
  // forever, with the head never moving. What has to hold is that the sequence converges on its own
  // and that a real author push still starts a real round.
  describe("the review round, tick over tick", () => {
    /** The peer's flow answering the request, recorded under its own login as GitHub records it. */
    async function peerReviews(gh: FakeGitHubGateway, commitId: string): Promise<void> {
      const mine = gh.login;
      gh.login = PEER;
      try {
        await gh.submitReview(REPO, PR, { commitId, event: "REQUEST_CHANGES", body: "needs work" });
      } finally {
        gh.login = mine;
      }
    }

    it("asks once per head: the peer answers, later ticks ask nothing, a push asks again", async () => {
      const gh = new FakeGitHubGateway();
      seedPr(gh, HEAD, [DOCS_FILE, SOURCE_FILE]);
      seedClean(gh, HEAD);

      // -- Tick 1: the change carries source, so the peer is asked.
      expect((await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: [PEER] })).status).toBe("requested");
      expect(await gh.listRequestedReviewers(REPO, PR)).toEqual({ users: [PEER], teams: [] });

      // The peer's flow reviews at that head, which clears its own request.
      await peerReviews(gh, HEAD);
      expect(await gh.listRequestedReviewers(REPO, PR)).toEqual({ users: [], teams: [] });

      // -- Ticks 2 and 3: the label is still there and no request is outstanding, and neither tick
      // may ask for anything. This is the loop: before the fix each of these answered "requested".
      for (const _ of [2, 3]) {
        expect((await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: [PEER] })).status).toBe("already-requested");
      }
      expect(await gh.listRequestedReviewers(REPO, PR)).toEqual({ users: [], teams: [] });
      expect(gh.reviews).toHaveLength(1); // one review, not one per tick
      expect((await gh.getPullRequest(REPO, PR)).labels).toEqual([TRIGGER]);

      // -- Tick 4: the author pushed, which is a genuine new round.
      push(gh, PUSHED);
      expect((await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: [PEER] })).status).toBe("requested");
      expect(await gh.listRequestedReviewers(REPO, PR)).toEqual({ users: [PEER], teams: [] });

      // ... and that round converges the same way.
      await peerReviews(gh, PUSHED);
      expect((await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: [PEER] })).status).toBe("already-requested");
      expect(gh.reviews).toHaveLength(2); // exactly one review per head, across four ticks
      expect(gh.reviews.map((r) => r.commitId)).toEqual([HEAD, PUSHED]);
    });
  });

  // Issue #48: a dependency bot's pull request is not a peer's to review. GitHub only forbids
  // approving your OWN pull request, so this agent may review and approve such a change itself, which
  // is the steward flow's job. Handing it to another engineer's agent adds a round trip and a person's
  // queue for nothing.
  describe("a pull request from a dependency bot", () => {
    it("is never handed to a peer, even when the gate asks for a review", async () => {
      const gh = new FakeGitHubGateway();
      seedPr(gh, HEAD, [DOCS_FILE, SOURCE_FILE]);
      gh.prs.get(`${REPO}#${PR}`)!.author = "renovate[bot]"; // the REST login behind issue #48
      gh.setActorType("renovate[bot]", "Bot");
      seedClean(gh, HEAD);

      // Steps 1 and 2 are unchanged: a real open pull request, and a gate verdict that names the
      // source path, which is exactly the reason step 3 would normally ask for a reviewer.
      expect((await stabilize(gh, { repo: REPO, pr: PR })).status).toBe("up-to-date");
      const proposed = await runExpedite(gh, tick(1));
      expect(proposed.action).toBe("proposed");
      expect(proposed.reasons.some((r) => r.startsWith("not auto-eligible:") && r.includes("source"))).toBe(true);

      // Step 3 refuses, and nothing at all is written on the pull request.
      const requested = await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: [PEER] });
      expect(requested.status).toBe("bot-authored");
      expect(requested.reason).toContain("steward");
      expect((await gh.getPullRequest(REPO, PR)).labels).toEqual([]); // no trigger label
      expect(await gh.listRequestedReviewers(REPO, PR)).toEqual({ users: [], teams: [] });
      expect(await gh.listReviewRequests(REPO, PEER)).toEqual([]); // the peer's queue never sees it
      expect(gh.merges).toEqual([]);

      // A second tick reports the same thing and still writes nothing: this is a stable outcome, not
      // a state to be retried into existence.
      expect((await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: [PEER] })).status).toBe("bot-authored");
      expect(await gh.listRequestedReviewers(REPO, PR)).toEqual({ users: [], teams: [] });
      // The only durable trace of the tick is the proposal comment step 2 posted.
      expect((await soleMarker(gh)).marker.kind).toBe("expedite-proposal");
    });

    // The refusal is only as wide as the steward's allowlist. A bot outside it would be declined
    // there too, so this flow has to keep handling it or the pull request gets no attention at all.
    it("still hands a bot the steward cannot take to a peer, source changes and all", async () => {
      const gh = new FakeGitHubGateway();
      seedPr(gh, HEAD, [DOCS_FILE, SOURCE_FILE]);
      gh.prs.get(`${REPO}#${PR}`)!.author = "github-actions[bot]";
      gh.setActorType("github-actions[bot]", "Bot");
      seedClean(gh, HEAD);

      const proposed = await runExpedite(gh, tick(1));
      expect(proposed.reasons.some((r) => r.startsWith("not auto-eligible:") && r.includes("source"))).toBe(true);

      const requested = await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: [PEER] });
      expect(requested.status).toBe("requested");
      expect((await gh.getPullRequest(REPO, PR)).labels).toEqual([TRIGGER]);
      expect(await gh.listRequestedReviewers(REPO, PR)).toEqual({ users: [PEER], teams: [] });
    });
  });

  describe("conflict", () => {
    it("stops the item at step 1 for a dirty branch, without even attempting a sync", async () => {
      const gh = new FakeGitHubGateway();
      seedPr(gh, HEAD);
      gh.setMergeability(REPO, PR, { state: "dirty", mergeable: false, draft: false, baseRef: "main", headSha: HEAD });

      const result = await stabilize(gh, { repo: REPO, pr: PR });
      expect(result.status).toBe("conflict");
      expect(result.detail).toContain("author");
      // Only the author can fix this, so the flow reports escalate-human and calls nothing else.
      expect(gh.updateBranchCalls).toEqual([]);
      expect(await gh.listComments(REPO, PR)).toEqual([]);
      expect(gh.merges).toEqual([]);
      expect(gh.reviews).toEqual([]);
      expect((await gh.getPullRequest(REPO, PR)).labels).toEqual([]);
      expect((await gh.getPullRequest(REPO, PR)).headSha).toBe(HEAD);
    });

    it("stops the item when a sync of a behind branch is refused, leaving only the attempt behind", async () => {
      const gh = new FakeGitHubGateway();
      seedPr(gh, HEAD);
      gh.setMergeability(REPO, PR, { state: "behind", mergeable: false, draft: false, baseRef: "main", headSha: HEAD });
      gh.setUpdateBranchResult("conflict");

      expect((await stabilize(gh, { repo: REPO, pr: PR })).status).toBe("conflict");
      // The attempted write is the one thing that happened; the branch itself did not move.
      expect(gh.updateBranchCalls).toEqual([{ repo: REPO, pr: PR, expectedHeadSha: HEAD, previousHeadSha: HEAD }]);
      expect((await gh.getPullRequest(REPO, PR)).headSha).toBe(HEAD);
      expect(await gh.listComments(REPO, PR)).toEqual([]);
      expect(gh.merges).toEqual([]);
    });
  });

  // The status split stabilize draws between "gone" and "blocked" is the whole reason Flow A's step 1
  // has two different branches, and reading one as the other is a deadlock either way round: treating
  // "blocked" as terminal abandons every pull request waiting for a required review, and treating
  // "gone" as continuable keeps working a closed pull request.
  describe("the gone / blocked split", () => {
    it("reports gone for a closed pull request, and the flow stops there", async () => {
      const gh = new FakeGitHubGateway();
      seedPr(gh, HEAD);
      gh.prs.get(`${REPO}#${PR}`)!.state = "closed";

      const result = await stabilize(gh, { repo: REPO, pr: PR });
      expect(result.status).toBe("gone");
      expect(result.detail).toContain("closed");
      expect(gh.updateBranchCalls).toEqual([]); // a closed pull request is never pushed to
      expect(await gh.listComments(REPO, PR)).toEqual([]);
    });

    it("reports blocked for a protected pull request, and the whole sequence CONTINUES through it", async () => {
      // The everyday state of a pull request on a protected repository: open, healthy, green, and
      // blocked purely because the required review has not been submitted yet. Syncing cannot change
      // that, which is exactly why the flow must not stop: step 3 is what unblocks it.
      const gh = new FakeGitHubGateway();
      seedPr(gh, HEAD, [DOCS_FILE, SOURCE_FILE]);
      gh.setMergeability(REPO, PR, { state: "blocked", mergeable: false, draft: false, baseRef: "main", headSha: HEAD });
      gh.setBranchProtection(REPO, "main", {
        requiresPullRequestReviews: true, requiredApprovingReviewCount: 1,
        requiredChecks: [], enforceAdmins: false, requiresConversationResolution: false,
      });

      const blocked = await stabilize(gh, { repo: REPO, pr: PR });
      expect(blocked.status).toBe("blocked");
      expect(blocked.status).not.toBe("gone"); // stated explicitly: this pull request is not finished
      expect(blocked.detail).toContain("blocked");
      expect(gh.updateBranchCalls).toEqual([]); // syncing would not help, so nothing is written

      // Step 2 still runs. It proposes and names the mergeable state and the unmet protection, so a
      // maintainer reading the comment learns why the pull request is stuck.
      const proposed = await runExpedite(gh, tick(1), { autonomy: "auto" });
      expect(proposed.action).toBe("proposed");
      expect(proposed.reasons.some((r) => r.includes("mergeable state is blocked"))).toBe(true);
      expect(proposed.reasons.some((r) => r.includes("branch protection"))).toBe(true);
      expect(gh.merges).toEqual([]); // a blocked state fails the gate even under autonomy auto
      const marker = await soleMarker(gh);
      expect(marker.marker.headSha).toBe(HEAD);

      // Step 3 still runs, which is the point: the missing required review is requestable.
      expect((await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: [PEER] })).status).toBe("requested");
      expect((await gh.getPullRequest(REPO, PR)).labels).toEqual([TRIGGER]);
      expect(await gh.listRequestedReviewers(REPO, PR)).toEqual({ users: [PEER], teams: [] });
    });
  });
});
