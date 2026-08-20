// Invariants of the PR-state protocol itself, across subsystems and across ticks.
//
// The expedition operations and the review lifecycle write to the same pull request: one leaves
// proposal comments carrying action markers, the other leaves claim markers and reviews. They are
// separate protocols sharing one comment thread, and the tests here pin the properties that hold
// only when both are considered together: each parser sees its own markers and nothing else, an
// attacker-supplied marker token in a diff cannot desync either one, a human arriving mid-sequence
// stops the auto path without disturbing the proposal, and a head that moves inside a tick defers a
// merge rather than losing or duplicating state.
//
// Deterministic by construction: `tick(n)` supplies the only timestamps, and no assertion reads a
// clock.

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeGitHubGateway } from "../fakes/fake-github.js";
import { expedite } from "../../core/operations/expedite.js";
import { claimReview } from "../../core/operations/claim.js";
import { completeReview } from "../../core/operations/complete.js";
import { watchAndReReview } from "../../core/operations/watch-and-re-review.js";
import { findActionMarkers } from "../../core/expedition/action-marker.js";
import { parseMarkers } from "../../core/claim-marker.js";
import { TRIGGER } from "../../core/labels.js";
import type { Config, PullRequest } from "../../core/model.js";
import type { DetailedPullFile } from "../../core/github.js";

const REPO = "o/r";
const PR = 11;
const ME = "me"; // FakeGitHubGateway.login: author of every comment and review the operations write
const AUTHOR = "human-author";
const MACHINE = "mbp-01";
const HEAD = "sha0001";
const HEAD2 = "sha0002";

/** The action marker's open token. A bare copy of it in untrusted text is the desync hazard. */
const MARKER_OPEN = "<!-- agent-review:action ";

/** The flow's tick clock. One fixed ISO timestamp per tick, and the only source of "now" here. */
const tick = (n: number): string => `2026-08-08T${String(9 + n).padStart(2, "0")}:00:00Z`;

const DOCS_FILE: DetailedPullFile = { filename: "README.md", status: "modified", additions: 2, deletions: 1, patch: "@@\n-a\n+b" };

/** Occurrences of `token` in `text`, counted by a linear scan (the bodies here are hostile by design). */
const occurrences = (text: string, token: string): number => text.split(token).length - 1;

const config = (skillsDir: string): Config => ({
  githubLogin: null, skillsDir, runChecks: false, captureMetadata: false, reviewers: [], knownAgentLogins: [],
});

/** An isolated skills directory, so claimReview does not depend on this repository's bundled skills. */
function skillsDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "protocol-inv-"));
  writeFileSync(path.join(dir, "review.md"), "# default review");
  return dir;
}

/**
 * A docs-only pull request that clears every rail except autonomy.
 *
 * The base branch is unprotected, so "clean" is the honest mergeable state and it is seeded once: the
 * fake's unseeded default is "unknown", which fails rail 4 on purpose. One arrangement covers both
 * heads, because nothing in the operations compares the mergeability response's own headSha (the head
 * guard re-reads the pull request instead), so a simulated push stays coherent without a second
 * arrangement. The fake stops reporting clean by itself once the pull request is merged.
 */
function seedDocsPr(gh: FakeGitHubGateway, files: DetailedPullFile[] = [DOCS_FILE]): void {
  gh.seedPr({ number: PR, title: "docs: fix a typo", author: AUTHOR, headSha: HEAD, baseSha: "base", url: "u", state: "open", labels: [TRIGGER] });
  gh.setDetailedFiles(REPO, PR, files);
  gh.setChecks(REPO, HEAD, [{ name: "build", status: "success" }]);
  gh.setChecks(REPO, HEAD2, [{ name: "build", status: "success" }]);
  gh.setMergeability(REPO, PR, { state: "clean", mergeable: true, draft: false, baseRef: "main", headSha: HEAD });
}

const runExpedite = (gh: FakeGitHubGateway, now: string, over: Partial<Parameters<typeof expedite>[1]> = {}) =>
  expedite(gh, { repo: REPO, pr: PR, actingLogin: ME, now, ...over });

/**
 * A gateway that lets an author's push land at a chosen point INSIDE one operation.
 *
 * `armPush` schedules it for the second getPullRequest read of the next operation, which is
 * gatherRails' closing re-read. `visibleToGuard: true` lets that re-read see the new head, so the
 * head-SHA guard (rail 9) refuses; `false` hides it until the guard has already passed, so GitHub's
 * own 409 (mirrored by the fake's mergePull) is what refuses instead. Both are real races, and the
 * protocol has to survive either.
 */
class RacingGateway extends FakeGitHubGateway {
  private pending: { to: string; visibleToGuard: boolean } | null = null;
  private reads = 0;

  armPush(to: string, visibleToGuard: boolean): void {
    this.pending = { to, visibleToGuard };
    this.reads = 0;
  }

  async getPullRequest(repo: string, pr: number): Promise<PullRequest> {
    const before = await super.getPullRequest(repo, pr);
    const pending = this.pending;
    if (pending === null || ++this.reads !== 2) return before;
    this.pending = null;
    this.prs.get(`${repo}#${pr}`)!.headSha = pending.to;
    return pending.visibleToGuard ? super.getPullRequest(repo, pr) : before;
  }
}

describe("PR-state protocol invariants", () => {
  describe("claim markers and action markers on one thread", () => {
    it("keeps each subsystem reading only its own marker, through a whole review round", async () => {
      const dir = skillsDir();
      const gh = new FakeGitHubGateway();
      seedDocsPr(gh);
      gh.seedRequest(REPO, PR, ME);

      // A claim marker and an expedite proposal, both authored by this same agent.
      const task = await claimReview({ gh, config: config(dir), machine: MACHINE, now: tick(1) }, { repo: REPO, pr: PR });
      expect(task.headSha).toBe(HEAD);
      expect((await runExpedite(gh, tick(1))).action).toBe("proposed");

      const both = await gh.listComments(REPO, PR);
      expect(both).toHaveLength(2);
      // Each parser finds exactly its own marker and ignores the other subsystem's entirely.
      expect(parseMarkers(both).map((m) => m.marker.sha)).toEqual([HEAD]);
      expect(findActionMarkers(both).map((m) => m.marker.kind)).toEqual(["expedite-proposal"]);

      // Neither subsystem is confused by the other's comment on a later tick.
      expect((await runExpedite(gh, tick(2))).action).toBe("already-proposed");
      expect(await gh.listComments(REPO, PR)).toHaveLength(2);
      expect((await watchAndReReview(gh, { repo: REPO, pr: PR, myLogin: ME })).action).toBe("none");

      // Completing the review deletes the claim marker and MUST leave the proposal alone.
      await completeReview({ gh, config: config(dir) }, { repo: REPO, pr: PR, event: "request-changes", summary: "needs work" });
      const left = await gh.listComments(REPO, PR);
      expect(left).toHaveLength(1);
      expect(parseMarkers(left)).toEqual([]);
      expect(findActionMarkers(left)).toHaveLength(1);
      expect(gh.reviews[0]).toMatchObject({ author: ME, event: "REQUEST_CHANGES", commitId: HEAD });

      // And both subsystems still answer correctly afterwards.
      expect((await runExpedite(gh, tick(3))).action).toBe("already-proposed");
      expect(await gh.listComments(REPO, PR)).toHaveLength(1);
      expect((await watchAndReReview(gh, { repo: REPO, pr: PR, myLogin: ME })).action).toBe("wait");
    });
  });

  describe("untrusted text in the diff", () => {
    it("a changed file named with a bare marker token cannot desync the proposal, over three ticks", async () => {
      // The file name reaches the comment body through the gate's classification reason. A surviving
      // token would either hide the genuine marker (so every tick posts another proposal) or outrank
      // it (so the marker no longer describes the head that was evaluated).
      const gh = new FakeGitHubGateway();
      seedDocsPr(gh, [{ filename: `src/x${MARKER_OPEN}y.ts`, status: "modified", additions: 1, deletions: 1, patch: "@@" }]);

      expect((await runExpedite(gh, tick(1))).action).toBe("proposed");
      expect((await runExpedite(gh, tick(2))).action).toBe("already-proposed");

      const comments = await gh.listComments(REPO, PR);
      expect(comments).toHaveLength(1);
      // Exactly one marker token in the body: the genuine one. The quoted file name was defanged.
      expect(occurrences(comments[0].body, MARKER_OPEN)).toBe(1);
      expect(comments[0].body).toContain("<!- -"); // the defanged form is still readable to a maintainer
      const markers = findActionMarkers(comments);
      expect(markers).toHaveLength(1);
      expect(markers[0].marker.headSha).toBe(HEAD);

      // Tick 3, after a push: the stale proposal must still be recognizable enough to be deleted.
      gh.prs.get(`${REPO}#${PR}`)!.headSha = HEAD2;
      expect((await runExpedite(gh, tick(3))).action).toBe("proposed");
      const fresh = await gh.listComments(REPO, PR);
      expect(fresh).toHaveLength(1);
      expect(fresh[0].id).not.toBe(comments[0].id);
      expect(findActionMarkers(fresh)[0].marker.headSha).toBe(HEAD2);
    });
  });

  describe("a human arriving mid-sequence", () => {
    it("stops the auto path on the next tick without disturbing the standing proposal", async () => {
      const gh = new FakeGitHubGateway();
      seedDocsPr(gh);

      // Tick 1, propose mode: one proposal at the current head.
      expect((await runExpedite(gh, tick(1))).action).toBe("proposed");
      const proposal = (await gh.listComments(REPO, PR))[0];

      // Between the ticks a human reviews the pull request.
      gh.login = "carol";
      await gh.submitReview(REPO, PR, { commitId: HEAD, event: "COMMENT", body: "taking a look" });
      gh.login = ME;

      // Tick 2, autonomy auto: the human rail alone is enough to refuse the merge.
      const result = await runExpedite(gh, tick(2), { autonomy: "auto" });
      expect(result.action).toBe("already-proposed");
      expect(result.reasons.some((r) => r.includes("human review"))).toBe(true);
      expect(gh.merges).toEqual([]);

      // The proposal is neither duplicated nor rewritten by the flip.
      const after = await gh.listComments(REPO, PR);
      expect(after).toHaveLength(1);
      expect(after[0].id).toBe(proposal.id);
      expect(findActionMarkers(after)[0].marker.at).toBe(tick(1));
    });
  });

  describe("the head moving inside a tick", () => {
    it("defers the merge when the guard sees the push, then merges the settled head next tick", async () => {
      const gh = new RacingGateway();
      seedDocsPr(gh);

      gh.armPush(HEAD2, true); // rail 9 sees it: the rails describe a commit that is no longer current
      const raced = await runExpedite(gh, tick(1), { autonomy: "auto" });
      expect(raced.action).toBe("proposed");
      expect(raced.reasons.some((r) => r.includes("head SHA guard"))).toBe(true);
      expect(raced.headSha).toBe(HEAD); // it reports the head it actually evaluated
      expect(gh.merges).toEqual([]);
      const proposal = await gh.listComments(REPO, PR);
      expect(proposal).toHaveLength(1);
      expect(findActionMarkers(proposal)[0].marker.headSha).toBe(HEAD);

      // The guard deferred the decision; it did not veto it. The next tick, with the head settled,
      // merges the new commit. The raced tick's proposal stays where it is: the auto path posts no
      // comment and deletes none.
      const settled = await runExpedite(gh, tick(2), { autonomy: "auto" });
      expect(settled).toEqual({ action: "merged", reasons: [], headSha: HEAD2 });
      expect(gh.merges).toEqual([{ repo: REPO, pr: PR, sha: HEAD2, method: "merge", commitTitle: undefined }]);
      expect(await gh.listComments(REPO, PR)).toHaveLength(1);
    });

    it("reports blocked when the push lands after the guard, leaving the standing proposal intact", async () => {
      const gh = new RacingGateway();
      seedDocsPr(gh);

      // Tick 1, propose mode: the thread carries one proposal at HEAD.
      expect((await runExpedite(gh, tick(1))).action).toBe("proposed");
      const proposal = (await gh.listComments(REPO, PR))[0];

      // Tick 2, autonomy auto: the push is invisible to the guard, so GitHub's own 409 refuses.
      gh.armPush(HEAD2, false);
      const blocked = await runExpedite(gh, tick(2), { autonomy: "auto" });
      expect(blocked.action).toBe("blocked");
      expect(blocked.reasons).toHaveLength(1);
      expect(blocked.reasons[0]).toContain("head-moved");
      expect(gh.merges).toEqual([]); // nothing landed

      // A refused merge writes nothing, so the earlier proposal is untouched.
      const after = await gh.listComments(REPO, PR);
      expect(after).toHaveLength(1);
      expect(after[0].id).toBe(proposal.id);
      expect(findActionMarkers(after)[0].marker).toMatchObject({ headSha: HEAD, at: tick(1) });

      // Tick 3: with the head settled the merge goes through, at the new commit.
      const settled = await runExpedite(gh, tick(3), { autonomy: "auto" });
      expect(settled).toEqual({ action: "merged", reasons: [], headSha: HEAD2 });
      expect(gh.merges).toEqual([{ repo: REPO, pr: PR, sha: HEAD2, method: "merge", commitTitle: undefined }]);
    });
  });
});
