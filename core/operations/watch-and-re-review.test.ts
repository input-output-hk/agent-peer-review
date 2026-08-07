import { describe, it, expect } from "vitest";
import { FakeGitHubGateway } from "../../test/fakes/fake-github.js";
import { watchAndReReview, DEFAULT_MAX_REVIEW_ROUNDS } from "./watch-and-re-review.js";
import { serializeMeta } from "../review-meta.js";

const REPO = "o/r";
const PR = 1;
const ME = "me";

function seed(headSha = "sha0002"): FakeGitHubGateway {
  const gh = new FakeGitHubGateway();
  gh.seedPr({ number: PR, title: "t", author: "human-author", headSha, baseSha: "b", url: "u", state: "open", labels: [] });
  return gh;
}

async function reviewAs(gh: FakeGitHubGateway, author: string, event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT", commitId: string, body = "notes") {
  const previous = gh.login;
  gh.login = author;
  await gh.submitReview(REPO, PR, { commitId, event, body });
  gh.login = previous;
}

const run = (gh: FakeGitHubGateway, over: Partial<Parameters<typeof watchAndReReview>[1]> = {}) =>
  watchAndReReview(gh, { repo: REPO, pr: PR, myLogin: ME, ...over });

describe("watchAndReReview", () => {
  it("never mutates anything", async () => {
    const gh = seed();
    await reviewAs(gh, ME, "REQUEST_CHANGES", "sha0001");
    const before = gh.reviews.length;
    await run(gh);
    expect(gh.reviews).toHaveLength(before);
    expect(await gh.listComments(REPO, PR)).toEqual([]);
    expect(gh.merges).toEqual([]);
    expect(gh.removedLabels).toEqual([]);
  });

  it.each(["closed", "merged"] as const)("reports abandoned for a %s pull request", async (state) => {
    const gh = seed();
    gh.prs.get(`${REPO}#${PR}`)!.state = state;
    await reviewAs(gh, ME, "REQUEST_CHANGES", "sha0001");
    const result = await run(gh);
    expect(result.action).toBe("abandoned");
    expect(result.reason).toContain(state);
  });

  it("reports none when this agent has never reviewed", async () => {
    const gh = seed();
    await reviewAs(gh, "alice", "REQUEST_CHANGES", "sha0001");
    expect((await run(gh)).action).toBe("none");
  });

  it("reports none when this agent has only commented, with no verdict", async () => {
    const gh = seed();
    await reviewAs(gh, ME, "COMMENT", "sha0001");
    expect((await run(gh)).action).toBe("none");
  });

  it("reports approved when this agent's latest verdict is an approval", async () => {
    const gh = seed();
    await reviewAs(gh, ME, "REQUEST_CHANGES", "sha0001");
    await reviewAs(gh, ME, "APPROVE", "sha0002");
    const result = await run(gh);
    expect(result.action).toBe("approved");
    expect(result.reason).toContain("sha0002");
    expect(result.reason).not.toContain("moved");
  });

  it("still reports approved after a push, but says the approval is stale", async () => {
    const gh = seed("sha0003"); // the author pushed past the approved commit
    await reviewAs(gh, ME, "APPROVE", "sha0002");
    const result = await run(gh);
    expect(result.action).toBe("approved"); // re-affirmation is a later phase, owned by the flow
    expect(result.reason).toContain("sha0002");
    expect(result.reason).toContain("sha0003");
    expect(result.reason).toContain("re-affirmation is a later phase");
  });

  it("decides the standing verdict from submission time, not the order reviews arrive in", async () => {
    const gh = seed("sha0001");
    await reviewAs(gh, ME, "APPROVE", "sha0001");
    await reviewAs(gh, ME, "REQUEST_CHANGES", "sha0001"); // later: this is the standing verdict
    gh.reviews.reverse(); // a gateway that hands them back newest-first must not change the answer
    expect((await run(gh)).action).toBe("wait");
  });

  it("reports wait while the head still sits at the reviewed commit", async () => {
    const gh = seed("sha0001");
    await reviewAs(gh, ME, "REQUEST_CHANGES", "sha0001");
    const result = await run(gh);
    expect(result.action).toBe("wait");
    expect(result.reason).toContain("sha0001");
  });

  it("ignores a later COMMENT when deciding the standing verdict", async () => {
    const gh = seed("sha0001");
    await reviewAs(gh, ME, "REQUEST_CHANGES", "sha0001");
    await reviewAs(gh, ME, "COMMENT", "sha0001");
    expect((await run(gh)).action).toBe("wait"); // the COMMENT did not replace the verdict
  });

  it("reports re-review once the author pushes", async () => {
    const gh = seed("sha0002");
    await reviewAs(gh, ME, "REQUEST_CHANGES", "sha0001");
    const result = await run(gh);
    expect(result.action).toBe("re-review");
    expect(result.reason).toContain("sha0001");
    expect(result.reason).toContain("sha0002");
  });

  describe("round cap", () => {
    it("holds for a human once the cap is reached, and says so", async () => {
      const gh = seed("sha0004");
      for (const sha of ["sha0001", "sha0002", "sha0003"]) await reviewAs(gh, ME, "REQUEST_CHANGES", sha);
      const result = await run(gh);
      expect(result.action).toBe("hold-for-human");
      expect(result.reason).toContain("cap");
      expect(result.reason).toContain(`3 of ${DEFAULT_MAX_REVIEW_ROUNDS}`);
    });

    it("still re-reviews one round below the cap", async () => {
      const gh = seed("sha0003");
      for (const sha of ["sha0001", "sha0002"]) await reviewAs(gh, ME, "REQUEST_CHANGES", sha);
      expect((await run(gh)).action).toBe("re-review");
    });

    it("honors a caller-supplied cap", async () => {
      const gh = seed("sha0002");
      await reviewAs(gh, ME, "REQUEST_CHANGES", "sha0001");
      expect((await run(gh, { maxReviewRounds: 1 })).action).toBe("hold-for-human");
    });

    it("counts this agent's COMMENT reviews toward the cap", async () => {
      const gh = seed("sha0003");
      await reviewAs(gh, ME, "REQUEST_CHANGES", "sha0001");
      await reviewAs(gh, ME, "COMMENT", "sha0002");
      expect((await run(gh, { maxReviewRounds: 2 })).action).toBe("hold-for-human");
    });
  });

  describe("human handover", () => {
    it("holds when a human has an open review request", async () => {
      const gh = seed("sha0002");
      await reviewAs(gh, ME, "REQUEST_CHANGES", "sha0001");
      gh.setRequestedReviewers(REPO, PR, { users: ["alice"], teams: [] });
      const result = await run(gh);
      expect(result.action).toBe("hold-for-human");
      expect(result.reason).toContain("human review");
    });

    it("holds when a team has an open review request", async () => {
      const gh = seed("sha0002");
      await reviewAs(gh, ME, "REQUEST_CHANGES", "sha0001");
      gh.setRequestedReviewers(REPO, PR, { users: [], teams: ["backend"] });
      expect((await run(gh)).action).toBe("hold-for-human");
    });

    it("holds when a human has already reviewed", async () => {
      const gh = seed("sha0002");
      await reviewAs(gh, ME, "REQUEST_CHANGES", "sha0001");
      await reviewAs(gh, "alice", "COMMENT", "sha0001");
      expect((await run(gh)).action).toBe("hold-for-human");
    });

    it("does not hold for a known peer agent's review", async () => {
      const gh = seed("sha0002");
      await reviewAs(gh, ME, "REQUEST_CHANGES", "sha0001");
      await reviewAs(gh, "peer-bot", "COMMENT", "sha0001");
      expect((await run(gh, { knownAgentLogins: ["peer-bot"] })).action).toBe("re-review");
    });

    // The meta footer is self-asserted, so it cannot promote an unrecognized login to "agent".
    // Holding for an agent the caller forgot to configure is the deliberate conservative direction.
    it("HOLDS for an agent-footered review by a login not in knownAgentLogins", async () => {
      const gh = seed("sha0002");
      await reviewAs(gh, ME, "REQUEST_CHANGES", "sha0001");
      await reviewAs(gh, "mystery-agent", "COMMENT", "sha0001", `notes\n\n${serializeMeta({ v: 1, role: "second-opinion", verdict: "comment" })}`);
      expect((await run(gh)).action).toBe("hold-for-human");
      // ... and naming that same login clears it, without any footer being involved.
      expect((await run(gh, { knownAgentLogins: ["mystery-agent"] })).action).toBe("re-review");
    });

    it("reports the cap before the human hold when both apply", async () => {
      const gh = seed("sha0004");
      for (const sha of ["sha0001", "sha0002", "sha0003"]) await reviewAs(gh, ME, "REQUEST_CHANGES", sha);
      gh.setRequestedReviewers(REPO, PR, { users: ["alice"], teams: [] });
      expect((await run(gh)).reason).toContain("cap");
    });
  });
});
