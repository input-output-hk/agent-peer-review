import { describe, it, expect } from "vitest";
import { FakeGitHubGateway } from "../../test/fakes/fake-github.js";
import { stabilize } from "./stabilize.js";
import type { Mergeability } from "../github.js";

const REPO = "o/r";

function seed(state: Mergeability["state"], over: Partial<Mergeability> = {}): FakeGitHubGateway {
  const gh = new FakeGitHubGateway();
  gh.seedPr({ number: 1, title: "t", author: "a", headSha: "sha0001", baseSha: "b", url: "u", state: "open", labels: [] });
  gh.setMergeability(REPO, 1, { state, mergeable: state === "clean", draft: false, baseRef: "main", headSha: "sha0001", ...over });
  return gh;
}

describe("stabilize", () => {
  it("reports up-to-date for a clean branch and mutates nothing", async () => {
    const gh = seed("clean");
    expect(await stabilize(gh, { repo: REPO, pr: 1 })).toMatchObject({ status: "up-to-date" });
    expect(gh.updateBranchCalls).toEqual([]);
  });

  it("updates a branch that is behind, pinning the head it read in the same tick", async () => {
    const gh = seed("behind");
    const result = await stabilize(gh, { repo: REPO, pr: 1 });
    expect(result.status).toBe("updated");
    expect(result.detail).toContain("main");
    expect(gh.updateBranchCalls).toEqual([{ repo: REPO, pr: 1, expectedHeadSha: "sha0001", previousHeadSha: "sha0001" }]);
    expect((await gh.getPullRequest(REPO, 1)).headSha).toBe("sha0001-updated"); // the update creates a new head
  });

  it("reports a conflict when the update is refused", async () => {
    const gh = seed("behind");
    gh.setUpdateBranchResult("conflict");
    const result = await stabilize(gh, { repo: REPO, pr: 1 });
    expect(result.status).toBe("conflict");
    expect(gh.updateBranchCalls).toHaveLength(1);
    expect((await gh.getPullRequest(REPO, 1)).headSha).toBe("sha0001"); // unchanged
  });

  it("reports blocked instead of throwing when this token cannot update a behind branch", async () => {
    const gh = seed("behind");
    gh.setUpdateBranchResult("forbidden");
    const result = await stabilize(gh, { repo: REPO, pr: 1 });
    expect(result.status).toBe("blocked");
    expect(result.detail).toContain("not allowed");
    expect((await gh.getPullRequest(REPO, 1)).headSha).toBe("sha0001");
  });

  it("reports a conflict for a dirty branch without attempting an update", async () => {
    const gh = seed("dirty");
    const result = await stabilize(gh, { repo: REPO, pr: 1 });
    expect(result.status).toBe("conflict");
    expect(result.detail).toContain("conflicts");
    expect(gh.updateBranchCalls).toEqual([]);
  });

  // These three states describe an OPEN pull request that syncing cannot help. They are reported as
  // "blocked", never as "gone": on a protected repository "blocked" is the everyday state of a pull
  // request whose required review has not been submitted yet, so a caller that read it as terminal
  // would abandon exactly the pull requests that still need a review requested.
  it.each(["blocked", "unstable", "unknown"] as const)("reports blocked for a %s state, naming it, and mutates nothing", async (state) => {
    const gh = seed(state);
    const result = await stabilize(gh, { repo: REPO, pr: 1 });
    expect(result.status).toBe("blocked");
    expect(result.detail).toContain(state);
    expect(gh.updateBranchCalls).toEqual([]);
  });

  it("keeps blocked distinct from gone: an open blocked pull request is never reported as gone", async () => {
    const gh = seed("blocked");
    expect((await stabilize(gh, { repo: REPO, pr: 1 })).status).not.toBe("gone");
  });

  describe("drafts", () => {
    it('reports draft for a "draft" mergeable state', async () => {
      const gh = seed("draft", { draft: true });
      expect(await stabilize(gh, { repo: REPO, pr: 1 })).toMatchObject({ status: "draft" });
      expect(gh.updateBranchCalls).toEqual([]);
    });

    it("honors the draft flag even when the state says the branch is behind", async () => {
      const gh = seed("behind", { draft: true });
      expect((await stabilize(gh, { repo: REPO, pr: 1 })).status).toBe("draft");
      expect(gh.updateBranchCalls).toEqual([]); // a draft is not synced either
    });
  });

  describe("pull request state", () => {
    // stabilize is the one operation that writes without first consulting the gate, so it owes the
    // same liveness check: a closed or merged pull request must never be pushed to. It reports
    // "gone" rather than "blocked" so a caller can tell "this is over" from "this is open and
    // waiting on something syncing cannot fix"; only "gone" is terminal.
    it.each(["closed", "merged"] as const)("reports gone for a %s pull request and syncs nothing", async (state) => {
      const gh = seed("behind");
      gh.prs.get("o/r#1")!.state = state;
      const result = await stabilize(gh, { repo: REPO, pr: 1 });
      expect(result.status).toBe("gone");
      expect(result.detail).toContain(state);
      expect(gh.updateBranchCalls).toEqual([]);
    });

    it("checks liveness before mergeability, so a closed pull request is gone whatever its state says", async () => {
      const gh = seed("blocked");
      gh.prs.get("o/r#1")!.state = "closed";
      expect((await stabilize(gh, { repo: REPO, pr: 1 })).status).toBe("gone");
    });
  });

  it("never comments, merges, labels, or reviews", async () => {
    const gh = seed("behind");
    await stabilize(gh, { repo: REPO, pr: 1 });
    expect(await gh.listComments(REPO, 1)).toEqual([]);
    expect(gh.merges).toEqual([]);
    expect(gh.reviews).toEqual([]);
    expect((await gh.getPullRequest(REPO, 1)).labels).toEqual([]);
  });
});
