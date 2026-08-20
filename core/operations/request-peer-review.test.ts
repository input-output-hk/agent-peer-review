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

  // Issue #48: a pull request from a dependency bot the steward handles is the steward's, not a
  // peer's. GitHub only forbids approving your OWN pull request, so this agent can review and approve
  // such a change itself, and handing a machine-checkable dependency bump to another engineer's agent
  // costs a round trip and a person's queue for nothing.
  //
  // The refusal is exactly as wide as the steward's own allowlist and no wider: refusing a bot the
  // steward would decline leaves the pull request with nobody at all, which is worse than the
  // behavior this replaced.
  describe("a pull request from a dependency bot the steward handles", () => {
    /** Nothing was written: no trigger label, no skill label, no reviewer request, either view of it. */
    async function assertNothingHappened(gh: FakeGitHubGateway): Promise<void> {
      expect((await gh.getPullRequest(REPO, PR)).labels).toEqual([]);
      expect(await gh.listRequestedReviewers(REPO, PR)).toEqual({ users: [], teams: [] });
      expect(await gh.listReviewRequests(REPO, "peer-bot")).toEqual([]);
      expect(await gh.listComments(REPO, PR)).toEqual([]);
    }

    it("is refused when the author is on the allowlist and GitHub says it is a Bot", async () => {
      const gh = seed();
      gh.prs.get(`${REPO}#${PR}`)!.author = "renovate[bot]"; // in DEFAULT_BOT_ALLOWLIST
      gh.setActorType("renovate[bot]", "Bot");
      const result = await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"], skills: ["security"] });
      expect(result.status).toBe("bot-authored");
      expect(result.reviewers).toEqual([]);
      expect(result.reason).toContain("steward");
      expect(result.reason).toContain("renovate[bot]");
      await assertNothingHappened(gh);
    });

    it("is refused for a [bot]-suffixed allowlisted name whatever the actor type says", async () => {
      const gh = seed();
      gh.prs.get(`${REPO}#${PR}`)!.author = "dependabot[bot]";
      gh.setActorType("dependabot[bot]", "User"); // the name shape is the confirmation here
      expect((await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"] })).status).toBe("bot-authored");
      await assertNothingHappened(gh);
    });

    // The shape the pull request in issue #48 really had. GitHub's GraphQL API (and so the `gh` CLI)
    // names an App integration `app/renovate` while the REST API reports `renovate[bot]`, and the
    // users API resolves neither, so a caller working from the GraphQL name says so on the allowlist.
    it("is refused for an app/ author name on a caller-supplied allowlist, actor type unknown", async () => {
      const gh = seed();
      gh.prs.get(`${REPO}#${PR}`)!.author = "app/renovate";
      gh.setActorType("app/renovate", "unknown");
      const result = await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"], botAllowlist: ["app/renovate"] });
      expect(result.status).toBe("bot-authored");
      expect(result.reason).toContain("app/renovate");
      await assertNothingHappened(gh);
    });

    it("is refused even on a later tick that already carries the trigger label", async () => {
      // An earlier round (or a human) may have labeled it. That is not a reason to add a request.
      const gh = seed([TRIGGER]);
      gh.prs.get(`${REPO}#${PR}`)!.author = "dependabot[bot]";
      expect((await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"] })).status).toBe("bot-authored");
      expect(await gh.listRequestedReviewers(REPO, PR)).toEqual({ users: [], teams: [] });
    });

    // The other half of the rule, and the reason it is a rule about the allowlist rather than about
    // bots: the steward path would decline this pull request as not an allowlisted dependency bot, so
    // refusing it here as well would leave nobody looking at it. A bot that writes source code is
    // precisely what a peer review is for.
    it("does NOT refuse a bot the steward cannot take, even a confirmed Bot account", async () => {
      const gh = seed();
      gh.prs.get(`${REPO}#${PR}`)!.author = "github-actions[bot]";
      gh.setActorType("github-actions[bot]", "Bot");
      const result = await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"] });
      expect(result.status).toBe("requested");
      expect((await gh.listRequestedReviewers(REPO, PR)).users).toEqual(["peer-bot"]);
      expect((await gh.getPullRequest(REPO, PR)).labels).toContain(TRIGGER);
    });

    it("does not refuse a human author whose name merely mentions a bot", async () => {
      const gh = seed();
      gh.prs.get(`${REPO}#${PR}`)!.author = "botanist";
      const result = await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"] });
      expect(result.status).toBe("requested");
      expect((await gh.listRequestedReviewers(REPO, PR)).users).toEqual(["peer-bot"]);
    });

    // The actor-type read is a refinement on a call that never made one before, so an unreadable
    // users API (403, 5xx: the gateway maps only 404 to "unknown") must not turn a human's peer
    // review request into an error.
    it("still requests a review when the actor-type read throws", async () => {
      const gh = seed();
      gh.prs.get(`${REPO}#${PR}`)!.author = "dependabot[bot]"; // allowlisted, so the read is reached
      gh.getActorType = async () => { throw new Error("403 from the users API"); };
      // The name shape still catches this one, which is the point of having two signals.
      expect((await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"] })).status).toBe("bot-authored");

      const human = seed();
      human.prs.get(`${REPO}#${PR}`)!.author = "a-human";
      human.getActorType = async () => { throw new Error("500 from the users API"); };
      expect((await requestPeerReview(human, { repo: REPO, pr: PR, reviewers: ["peer-bot"] })).status).toBe("requested");
      expect((await human.listRequestedReviewers(REPO, PR)).users).toEqual(["peer-bot"]);
    });

    it("caters for case in the bot name shapes", async () => {
      const gh = seed();
      gh.prs.get(`${REPO}#${PR}`)!.author = "Dependabot[BOT]";
      gh.setActorType("Dependabot[BOT]", "unknown");
      const result = await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"], botAllowlist: ["Dependabot[BOT]"] });
      expect(result.status).toBe("bot-authored");
      await assertNothingHappened(gh);
    });
  });

  it("errors when no reviewers were resolved", async () => {
    const gh = seed();
    await expect(requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: [] })).rejects.toThrow(/No reviewers/);
    expect((await gh.getPullRequest(REPO, PR)).labels).toEqual([]); // nothing was touched first
  });
});
