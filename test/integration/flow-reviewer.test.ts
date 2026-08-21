// Flow B (pr-reviewer) end to end, at the operation level: the claim -> complete -> watch lifecycle
// the flow's instructions.md drives, run as multi-tick sequences over the real operations.
//
// What the per-operation unit tests cannot show is the loop: claimReview posts a marker that
// completeReview consumes, completeReview writes the review that watchAndReReview then follows, and
// the answer changes as the author pushes. Every tick below therefore asserts the durable trail
// (claim markers, submitted reviews and the commit each is pinned to, cleared review requests) as
// well as the verb the flow branches on.
//
// Deterministic by construction: `tick(n)` supplies the only timestamps, and no assertion reads a
// clock.

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeGitHubGateway } from "../fakes/fake-github.js";
import { claimReview } from "../../core/operations/claim.js";
import { completeReview } from "../../core/operations/complete.js";
import { watchAndReReview } from "../../core/operations/watch-and-re-review.js";
import { parseMarkers, PRIMARY_MARKER } from "../../core/claim-marker.js";
import { TRIGGER } from "../../core/labels.js";
import type { Config } from "../../core/model.js";

const REPO = "o/r";
const PR = 7;
const ME = "me"; // FakeGitHubGateway.login: the reviewer this flow acts as
const AUTHOR = "human-author";
const MACHINE = "mbp-01";
const HEAD1 = "sha0001";
const HEAD2 = "sha0002";
const HEAD3 = "sha0003";

/** The flow's tick clock. One fixed ISO timestamp per tick, and the only source of "now" here. */
const tick = (n: number): string => `2026-08-08T${String(9 + n).padStart(2, "0")}:00:00Z`;

/**
 * The minimal review config: metadata capture off, so the review bodies and claim markers below are
 * exactly the v1 shapes the flow ships with today.
 */
const config = (skillsDir: string): Config => ({
  githubLogin: null, skillsDir, runChecks: false, captureMetadata: false, reviewers: [], knownAgentLogins: [],
});

/** An isolated skills directory, so claimReview does not depend on this repository's bundled skills. */
function skillsDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "flow-reviewer-"));
  writeFileSync(path.join(dir, "review.md"), "# default review");
  return dir;
}

/** A pull request this agent has been asked to review: open, labeled, and requested from ME. */
function seedRequestedPr(gh: FakeGitHubGateway, headSha: string): void {
  gh.seedPr({ number: PR, title: "feat: something", author: AUTHOR, headSha, baseSha: "base", url: "u", state: "open", labels: [TRIGGER] });
  gh.seedRequest(REPO, PR, ME);
  gh.setRequestedReviewers(REPO, PR, { users: [ME], teams: [] });
}

/** An author push: the pull request's head moves to a new commit. */
function push(gh: FakeGitHubGateway, headSha: string): void {
  gh.prs.get(`${REPO}#${PR}`)!.headSha = headSha;
}

/** A review by somebody else, recorded under their login. */
async function reviewBy(gh: FakeGitHubGateway, login: string, event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT", commitId: string): Promise<void> {
  const mine = gh.login;
  gh.login = login;
  try {
    await gh.submitReview(REPO, PR, { commitId, event, body: "a look from elsewhere" });
  } finally {
    gh.login = mine;
  }
}

/** One full review round, as `kind = requested` runs it: claim, then complete at the pinned commit. */
async function reviewRound(
  gh: FakeGitHubGateway,
  dir: string,
  now: string,
  event: "approve" | "request-changes",
): Promise<string> {
  const task = await claimReview({ gh, config: config(dir), machine: MACHINE, now }, { repo: REPO, pr: PR });
  await completeReview({ gh, config: config(dir) }, { repo: REPO, pr: PR, event, summary: `verdict at ${task.headSha}` });
  return task.headSha;
}

const watch = (gh: FakeGitHubGateway, over: Partial<Parameters<typeof watchAndReReview>[1]> = {}) =>
  watchAndReReview(gh, { repo: REPO, pr: PR, myLogin: ME, ...over });

describe("Flow B (pr-reviewer): claim, complete, watch, re-review", () => {
  it("runs the full loop: request changes, wait, re-review on a push, approve, then hold the approval", async () => {
    const dir = skillsDir();
    const gh = new FakeGitHubGateway();
    seedRequestedPr(gh, HEAD1);

    // -- Tick 1, kind = requested: claim pins the head and leaves a marker; complete consumes it.
    const task = await claimReview({ gh, config: config(dir), machine: MACHINE, now: tick(1) }, { repo: REPO, pr: PR });
    expect(task.headSha).toBe(HEAD1);
    expect(task.role).toBe("anchor");
    const claimed = parseMarkers(await gh.listComments(REPO, PR));
    expect(claimed).toHaveLength(1);
    expect(claimed[0].marker).toMatchObject({ v: 1, reviewer: ME, machine: MACHINE, sha: HEAD1, claimedAt: tick(1) });

    await completeReview({ gh, config: config(dir) }, { repo: REPO, pr: PR, event: "request-changes", summary: "needs work" });
    expect(gh.reviews).toHaveLength(1);
    expect(gh.reviews[0]).toMatchObject({ author: ME, event: "REQUEST_CHANGES", state: "CHANGES_REQUESTED", commitId: HEAD1 });
    expect(await gh.listComments(REPO, PR)).toEqual([]);                    // the claim marker is cleared
    expect(await gh.listRequestedReviewers(REPO, PR)).toEqual({ users: [], teams: [] }); // GitHub clears the request

    // -- Tick 2, kind = watching: nothing has been pushed, so there is nothing to do.
    const waiting = await watch(gh);
    expect(waiting.action).toBe("wait");
    expect(waiting.reason).toContain(HEAD1);
    expect(gh.reviews).toHaveLength(1); // a wait writes nothing

    // -- Tick 3: the author pushed, so the flow re-runs the requested cycle and approves this time.
    push(gh, HEAD2);
    const again = await watch(gh);
    expect(again.action).toBe("re-review");
    expect(again.reason).toContain(HEAD1);
    expect(again.reason).toContain(HEAD2);

    const pinned = await reviewRound(gh, dir, tick(3), "approve");
    expect(pinned).toBe(HEAD2); // the fresh claim pinned the new head, not the one reviewed before
    expect(gh.reviews).toHaveLength(2);
    expect(gh.reviews[1]).toMatchObject({ author: ME, event: "APPROVE", state: "APPROVED", commitId: HEAD2 });
    expect(await gh.listComments(REPO, PR)).toEqual([]);

    // -- Tick 4: the approval stands, so the flow stops. It stays "approved" after a later push, and
    // the reason names both commits so the flow is never surprised by a stale approval.
    const approved = await watch(gh);
    expect(approved.action).toBe("approved");
    expect(approved.reason).toContain(HEAD2);

    push(gh, HEAD3);
    const stale = await watch(gh);
    expect(stale.action).toBe("approved");
    expect(stale.reason).toContain(HEAD2);
    expect(stale.reason).toContain(HEAD3);
    expect(stale.reason).toContain("moved");
    expect(gh.reviews).toHaveLength(2); // still two reviews: watching never writes
  });

  describe("handing over to a human", () => {
    it("holds when an unrecognized login has reviewed, and does not hold for a configured agent", async () => {
      const dir = skillsDir();
      const gh = new FakeGitHubGateway();
      seedRequestedPr(gh, HEAD1);
      await reviewRound(gh, dir, tick(1), "request-changes");
      push(gh, HEAD2); // past the "wait" branch: without a push the answer is wait either way

      // A human review, with no footer of any kind: an unknown login is a human, full stop.
      await reviewBy(gh, "carol", "COMMENT", HEAD2);
      const held = await watch(gh);
      expect(held.action).toBe("hold-for-human");
      expect(held.reason).toContain("human review");
      expect(gh.reviews).toHaveLength(2); // this agent wrote nothing further

      // The same review by a login the caller lists as an agent does not hold the pull request.
      const gh2 = new FakeGitHubGateway();
      seedRequestedPr(gh2, HEAD1);
      await reviewRound(gh2, skillsDir(), tick(1), "request-changes");
      push(gh2, HEAD2);
      await reviewBy(gh2, "peer-bot", "COMMENT", HEAD2);
      expect((await watch(gh2, { knownAgentLogins: ["peer-bot"] })).action).toBe("re-review");
      expect((await watch(gh2)).action).toBe("hold-for-human"); // and the same state without the config entry
    });

    it("holds once the round cap is spent, naming the cap", async () => {
      const dir = skillsDir();
      const gh = new FakeGitHubGateway();
      seedRequestedPr(gh, HEAD1);

      // Round 1 of 2.
      expect(await reviewRound(gh, dir, tick(1), "request-changes")).toBe(HEAD1);
      push(gh, HEAD2);
      expect((await watch(gh, { maxReviewRounds: 2 })).action).toBe("re-review");

      // Round 2 of 2.
      expect(await reviewRound(gh, dir, tick(2), "request-changes")).toBe(HEAD2);
      push(gh, HEAD3);
      const capped = await watch(gh, { maxReviewRounds: 2 });
      expect(capped.action).toBe("hold-for-human");
      expect(capped.reason).toContain("round cap");
      expect(capped.reason).toContain("2 of 2");

      // The cap is what stops the ping-pong: two reviews written, and no third round is offered
      // however many ticks run.
      expect(gh.reviews).toHaveLength(2);
      expect(gh.reviews.map((r) => r.commitId)).toEqual([HEAD1, HEAD2]);
      expect((await watch(gh, { maxReviewRounds: 2 })).action).toBe("hold-for-human");
      expect(await gh.listComments(REPO, PR)).toEqual([]); // and no claim marker was left behind
    });
  });

  // Issue #52, livelock 2: a claim marker was a permanent SHA pin. An agent whose run stalled
  // re-claimed the dead commit on every tick, reviewed code that no longer existed, and the drift
  // that produced then read to the watch path as an author push, manufacturing another round with no
  // author action at all. So the loop had no exit: review a dead commit, see "the head moved",
  // re-review the same dead commit.
  describe("a claim that outlives the commit it pinned", () => {
    it("re-pins to the current head, and the completed review is not drifted", async () => {
      const dir = skillsDir();
      const gh = new FakeGitHubGateway();
      seedRequestedPr(gh, HEAD1);

      // Tick 1: the claim lands, and then this agent's run stalls before completing.
      const stalled = await claimReview({ gh, config: config(dir), machine: MACHINE, now: tick(1) }, { repo: REPO, pr: PR });
      expect(stalled.headSha).toBe(HEAD1);
      expect(parseMarkers(await gh.listComments(REPO, PR))[0].marker.sha).toBe(HEAD1);

      // The author pushes twice while nothing is running. HEAD1 is now a commit nobody can review.
      push(gh, HEAD2);
      push(gh, HEAD3);

      // Tick 2: the same agent claims again. It must pin the CURRENT head.
      const resumed = await claimReview({ gh, config: config(dir), machine: MACHINE, now: tick(2) }, { repo: REPO, pr: PR });
      expect(resumed.headSha).toBe(HEAD3);
      expect(resumed.role).toBe("anchor"); // re-pinning does not cost the anchor its place
      const repinned = parseMarkers(await gh.listComments(REPO, PR));
      expect(repinned).toHaveLength(1); // the stale marker is gone, not merely outnumbered
      expect(repinned[0].marker).toMatchObject({ sha: HEAD3, claimedAt: tick(1) });

      // The review therefore lands on the live commit, and nothing is flagged as drifted.
      const completed = await completeReview({ gh, config: config(dir) }, { repo: REPO, pr: PR, event: "request-changes", summary: "needs work" });
      expect(completed.drifted).toBe(false);
      expect(gh.reviews).toHaveLength(1);
      expect(gh.reviews[0]).toMatchObject({ author: ME, commitId: HEAD3, state: "CHANGES_REQUESTED" });
      expect(gh.reviews[0].body).not.toContain("PR head is now"); // no drift note for a maintainer to read

      // And the tick straight afterwards waits for the author instead of manufacturing a round out of
      // its own drift.
      const next = await watch(gh);
      expect(next.action).toBe("wait");
      expect(next.reason).toContain(HEAD3);
    });
  });

  // Issue #52, livelock 3: the cap counted every review this agent wrote, and a second opinion is a
  // COMMENTED review. Two of them plus one real verdict spent a cap meant for three rounds of
  // back-and-forth, and because the count only grows, hold-for-human was then permanent for that
  // pull request whatever the human did.
  describe("second opinions and the round cap", () => {
    const HEAD4 = "sha0004";

    /** A competing primary for the round: another agent's tagged review at `commitId`. */
    async function competingPrimary(gh: FakeGitHubGateway, login: string, commitId: string): Promise<void> {
      const mine = gh.login;
      gh.login = login;
      try {
        await gh.submitReview(REPO, PR, { commitId, event: "REQUEST_CHANGES", body: `verdict\n\n${PRIMARY_MARKER}` });
      } finally {
        gh.login = mine;
      }
    }

    it("two rounds this agent was superseded in do not spend a cap of three", async () => {
      const dir = skillsDir();
      const gh = new FakeGitHubGateway();
      seedRequestedPr(gh, HEAD1);

      // Rounds 1 and 2: a peer agent got its primary in first at each head, so completeReview
      // downgrades this agent's own write to a second-opinion COMMENT. That is the flow working as
      // designed, and it asks the author for nothing.
      for (const head of [HEAD1, HEAD2]) {
        if (head !== HEAD1) push(gh, head);
        await competingPrimary(gh, "peer-bot", head);
        const superseded = await claimReview({ gh, config: config(dir), machine: MACHINE, now: tick(1) }, { repo: REPO, pr: PR });
        expect(superseded.headSha).toBe(head);
        const done = await completeReview({ gh, config: config(dir) }, { repo: REPO, pr: PR, event: "request-changes", summary: "also this" });
        expect(done.superseded).toBe(true);
      }
      expect(gh.reviews.filter((r) => r.author === ME).map((r) => r.state)).toEqual(["COMMENTED", "COMMENTED"]);

      // Round 3: no competitor, so this agent's verdict stands. That is round one of three.
      push(gh, HEAD3);
      expect(await reviewRound(gh, dir, tick(3), "request-changes")).toBe(HEAD3);
      expect(gh.reviews.filter((r) => r.author === ME)).toHaveLength(3);

      // The author pushes. Three reviews by this agent, one verdict: the cap is not spent, so the
      // flow keeps working the pull request instead of handing it over for good.
      push(gh, HEAD4);
      const next = await watch(gh, { maxReviewRounds: 3, knownAgentLogins: ["peer-bot"] });
      expect(next.action).toBe("re-review");
      expect(next.reason).toContain(HEAD3);
      expect(next.reason).toContain(HEAD4);

      // ... and the cap still bites once three VERDICTS are in.
      expect(await reviewRound(gh, dir, tick(4), "request-changes")).toBe(HEAD4);
      push(gh, "sha0005");
      expect(await reviewRound(gh, dir, tick(5), "request-changes")).toBe("sha0005");
      push(gh, "sha0006");
      const capped = await watch(gh, { maxReviewRounds: 3, knownAgentLogins: ["peer-bot"] });
      expect(capped.action).toBe("hold-for-human");
      expect(capped.reason).toContain("3 of 3");
    });
  });

  it("reports the pull request abandoned once it is closed", async () => {
    const dir = skillsDir();
    const gh = new FakeGitHubGateway();
    seedRequestedPr(gh, HEAD1);
    await reviewRound(gh, dir, tick(1), "request-changes");
    push(gh, HEAD2);

    gh.prs.get(`${REPO}#${PR}`)!.state = "closed";
    const abandoned = await watch(gh);
    expect(abandoned.action).toBe("abandoned");
    expect(abandoned.reason).toContain("closed");
    expect(gh.reviews).toHaveLength(1); // the closed pull request is left exactly as it was
    expect(await gh.listComments(REPO, PR)).toEqual([]);
  });

  it("reports none when this agent has no verdict of its own to follow up on", async () => {
    const gh = new FakeGitHubGateway();
    seedRequestedPr(gh, HEAD1);
    // Somebody else's review says nothing about what THIS agent should do next.
    await reviewBy(gh, "carol", "REQUEST_CHANGES", HEAD1);
    expect((await watch(gh)).action).toBe("none");
  });
});
