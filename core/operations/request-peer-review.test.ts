import { describe, it, expect } from "vitest";
import { FakeGitHubGateway } from "../../test/fakes/fake-github.js";
import { requestPeerReview } from "./request-peer-review.js";
import { TRIGGER } from "../labels.js";

const REPO = "o/r";
const PR = 1;

function seed(labels: string[] = []): FakeGitHubGateway {
  const gh = new FakeGitHubGateway();
  gh.seedPr({ number: PR, title: "t", author: "me", headSha: "sha0001", baseSha: "b", url: "u", state: "open", labels });
  return gh;
}

describe("requestPeerReview", () => {
  it("labels the pull request and requests the reviewer", async () => {
    const gh = seed();
    const result = await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"], skills: ["security"] });
    expect(result).toEqual({ status: "requested", reviewers: ["peer-bot"] });
    expect((await gh.getPullRequest(REPO, PR)).labels).toEqual([TRIGGER, "security"]);
    expect((await gh.listRequestedReviewers(REPO, PR)).users).toEqual(["peer-bot"]);
  });

  it("is idempotent across ticks: a second call changes nothing", async () => {
    const gh = seed();
    await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"] });
    const second = await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"], skills: ["security"] });
    expect(second.status).toBe("already-requested");
    expect((await gh.getPullRequest(REPO, PR)).labels).toEqual([TRIGGER]); // the skill label was never applied
  });

  it("re-requests when the trigger label is present but no target reviewer is outstanding", async () => {
    // The peer already answered, which clears the request natively. Asking again starts a new round.
    const gh = seed([TRIGGER]);
    const result = await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"] });
    expect(result.status).toBe("requested");
    expect((await gh.listRequestedReviewers(REPO, PR)).users).toEqual(["peer-bot"]);
  });

  it("re-requests when a reviewer is outstanding but the trigger label was removed", async () => {
    const gh = seed();
    gh.setRequestedReviewers(REPO, PR, { users: ["peer-bot"], teams: [] });
    const result = await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"] });
    expect(result.status).toBe("requested");
    expect((await gh.getPullRequest(REPO, PR)).labels).toContain(TRIGGER);
  });

  it("treats any one of the target reviewers being outstanding as already requested", async () => {
    const gh = seed([TRIGGER]);
    gh.setRequestedReviewers(REPO, PR, { users: ["other-bot"], teams: [] });
    const result = await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot", "other-bot"] });
    expect(result.status).toBe("already-requested");
  });

  it("does not treat an unrelated human reviewer as its own request", async () => {
    const gh = seed([TRIGGER]);
    gh.setRequestedReviewers(REPO, PR, { users: ["alice"], teams: [] });
    const result = await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"] });
    expect(result.status).toBe("requested");
    expect((await gh.listRequestedReviewers(REPO, PR)).users).toEqual(["alice", "peer-bot"]);
  });

  // Issue #48: a bot-authored pull request is the steward's, not a peer's. GitHub only forbids
  // approving your OWN pull request, so this agent can review and approve a bot's itself, and
  // handing a machine-checkable dependency bump to another engineer's agent costs a round trip and a
  // person's queue for nothing.
  describe("a bot-authored pull request", () => {
    /** Nothing was written: no trigger label, no skill label, no reviewer request, either view of it. */
    async function assertNothingHappened(gh: FakeGitHubGateway): Promise<void> {
      expect((await gh.getPullRequest(REPO, PR)).labels).toEqual([]);
      expect(await gh.listRequestedReviewers(REPO, PR)).toEqual({ users: [], teams: [] });
      expect(await gh.listReviewRequests(REPO, "peer-bot")).toEqual([]);
      expect(await gh.listComments(REPO, PR)).toEqual([]);
    }

    it("is refused when GitHub says the author is a Bot account, and nothing is requested", async () => {
      const gh = seed();
      gh.prs.get(`${REPO}#${PR}`)!.author = "renovate";
      gh.setActorType("renovate", "Bot");
      const result = await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"], skills: ["security"] });
      expect(result.status).toBe("bot-authored");
      expect(result.reviewers).toEqual([]);
      expect(result.reason).toContain("steward");
      expect(result.reason).toContain("renovate");
      await assertNothingHappened(gh);
    });

    // The shape the pull request in issue #48 really had: an App integration, whose author string
    // the users API does not resolve, so the actor type alone would have let it through.
    it("is refused for an app/ author name even when the actor type is unknown", async () => {
      const gh = seed();
      gh.prs.get(`${REPO}#${PR}`)!.author = "app/renovate";
      gh.setActorType("app/renovate", "unknown");
      const result = await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"] });
      expect(result.status).toBe("bot-authored");
      expect(result.reason).toContain("app/renovate");
      await assertNothingHappened(gh);
    });

    it("is refused for a [bot]-suffixed author name whatever the actor type says", async () => {
      const gh = seed();
      gh.prs.get(`${REPO}#${PR}`)!.author = "dependabot[bot]";
      gh.setActorType("dependabot[bot]", "User"); // the name is enough; this is the safe direction
      expect((await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"] })).status).toBe("bot-authored");
      await assertNothingHappened(gh);
    });

    it("is refused even on a later tick that already carries the trigger label", async () => {
      // An earlier round (or a human) may have labeled it. That is not a reason to add a request.
      const gh = seed([TRIGGER]);
      gh.prs.get(`${REPO}#${PR}`)!.author = "app/dependabot";
      expect((await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"] })).status).toBe("bot-authored");
      expect(await gh.listRequestedReviewers(REPO, PR)).toEqual({ users: [], teams: [] });
    });

    it("does not refuse a human author whose name merely mentions a bot", async () => {
      const gh = seed();
      gh.prs.get(`${REPO}#${PR}`)!.author = "botanist";
      const result = await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"] });
      expect(result.status).toBe("requested");
      expect((await gh.listRequestedReviewers(REPO, PR)).users).toEqual(["peer-bot"]);
    });
  });

  it("errors when no reviewers were resolved", async () => {
    const gh = seed();
    await expect(requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: [] })).rejects.toThrow(/No reviewers/);
    expect((await gh.getPullRequest(REPO, PR)).labels).toEqual([]); // nothing was touched first
  });
});
