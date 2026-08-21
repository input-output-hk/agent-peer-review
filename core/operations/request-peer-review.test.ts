import { describe, it, expect } from "vitest";
import { FakeGitHubGateway } from "../../test/fakes/fake-github.js";
import { requestPeerReview } from "./request-peer-review.js";
import { TRIGGER } from "../labels.js";
import { serializeSelfReviewMarker } from "../self-review.js";

const REPO = "o/r";
const PR = 1;

function seedSelfReview(gh: FakeGitHubGateway, sha: string, author = "me"): void {
  gh.comments.set(`${REPO}#${PR}`, [{
    id: 900, author,
    body: `## Self-review\n\nReady for peer review.\n\n${serializeSelfReviewMarker({ v: 1, author, sha, status: "passed" })}`,
  }]);
}

function seed(labels: string[] = [], selfReviewed = true): FakeGitHubGateway {
  const gh = new FakeGitHubGateway();
  gh.seedPr({ number: PR, title: "t", author: "me", headSha: "sha0001", baseSha: "b", url: "u", state: "open", labels });
  if (selfReviewed) seedSelfReview(gh, "sha0001");
  return gh;
}

describe("requestPeerReview", () => {
  it("refuses to consume a peer's queue before the author's successful self-review", async () => {
    const gh = seed([], false);
    const result = await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"] });
    expect(result.status).toBe("self-review-required");
    expect(result.reason).toContain("Self-review");
    expect(await gh.listRequestedReviewers(REPO, PR)).toEqual({ users: [], teams: [] });
  });

  it("does not accept an existing request as a substitute for the author's self-review", async () => {
    const gh = seed([TRIGGER], false);
    gh.setRequestedReviewers(REPO, PR, { users: ["peer-bot"], teams: [] });

    const result = await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"] });

    expect(result.status).toBe("self-review-required");
    expect(result.reviewers).toEqual([]);
  });

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
      // The fixture's prior successful author self-review is not a write by this operation.
      expect(await gh.listComments(REPO, PR)).toHaveLength(1);
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

    // The name shape stands in for the actor type only where GitHub has no answer, never against
    // one. A login GitHub calls a User is not a bot however it is spelled, which is what keeps an
    // allowlisted NAME from being squatted into either automated path; `approveDependencyUpgrade`
    // refuses the same author for the same reason, so the two cannot disagree about who owns it.
    // Requesting a peer review is also the safe direction to be wrong in: the change gets a look.
    it("is NOT refused for an allowlisted name GitHub positively reports as a User", async () => {
      const gh = seed();
      gh.prs.get(`${REPO}#${PR}`)!.author = "dependabot[bot]";
      gh.setActorType("dependabot[bot]", "User");
      const result = await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"] });
      expect(result.status).toBe("requested");
      expect((await gh.listRequestedReviewers(REPO, PR)).users).toEqual(["peer-bot"]);
    });

    // The shape the pull requests in issues #48 and #50 really had. GitHub's GraphQL API (and so the
    // `gh` CLI, and so a discover script) names an App integration `app/renovate` while the REST API
    // reports `renovate[bot]`, and `GET /users/app/renovate` is a 404, so the users API confirms
    // nothing. Both spellings fold to one identity, so the DEFAULT allowlist covers this: it used to
    // take a caller-supplied allowlist naming the GraphQL spelling.
    it("is refused for an app/ author name on the default allowlist, actor type unknown", async () => {
      const gh = seed();
      gh.prs.get(`${REPO}#${PR}`)!.author = "app/renovate";
      gh.setActorType("app/renovate", "unknown");
      const result = await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"] });
      expect(result.status).toBe("bot-authored");
      expect(result.reason).toContain("app/renovate");
      await assertNothingHappened(gh);
    });

    it("is refused even on a later tick that already carries the trigger label", async () => {
      // An earlier round (or a human) may have labeled it. That is not a reason to add a request.
      const gh = seed([TRIGGER]);
      gh.prs.get(`${REPO}#${PR}`)!.author = "dependabot[bot]";
      gh.setActorType("dependabot[bot]", "Bot");
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

    it("does not let a caller widen the shared dependency-bot boundary", async () => {
      const gh = seed();
      gh.prs.get(`${REPO}#${PR}`)!.author = "github-actions[bot]";
      gh.setActorType("github-actions[bot]", "Bot");
      const result = await requestPeerReview(gh, {
        repo: REPO, pr: PR, reviewers: ["peer-bot"], botAllowlist: ["github-actions[bot]"],
      });
      expect(result.status).toBe("requested");
      expect((await gh.listRequestedReviewers(REPO, PR)).users).toEqual(["peer-bot"]);
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

    // Every spelling of the same two bots, against the DEFAULT allowlist and with the users API
    // resolving nothing: one identity per bot, whichever surface the name arrived on and in whatever
    // case. This is the refusal half of issue #50; the steward's acceptance half is next to it.
    it.each(["app/renovate", "renovate[bot]", "app/dependabot", "dependabot[bot]", "App/Renovate", "Dependabot[BOT]"])(
      "refuses %s on the default allowlist with the actor type unknown",
      async (author) => {
        const gh = seed();
        gh.prs.get(`${REPO}#${PR}`)!.author = author;
        gh.setActorType(author, "unknown");
        expect((await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"] })).status).toBe("bot-authored");
        await assertNothingHappened(gh);
      },
    );

    // A login carrying no bot marker at all, which the fold leaves untouched: it may equal a listed
    // bot's identity and still not be that bot, so GitHub has to vouch for it.
    it.each(["renovate", "app/some-codegen", "github-actions[bot]", "botanist"])(
      "does not refuse %s when the users API cannot confirm it",
      async (author) => {
        const gh = seed();
        gh.prs.get(`${REPO}#${PR}`)!.author = author;
        gh.setActorType(author, "unknown");
        expect((await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"] })).status).toBe("requested");
      },
    );
  });

  // Issue #52, livelock 1. Returning "already-requested" only while an OPEN request stood made this
  // operation re-request on the tick after the peer answered, because submitting a review clears the
  // request natively. The peer's flow then reviewed again, and again, with the head never moving:
  // one full agent invocation per tick, per pull request, forever. The round decision is keyed on the
  // head commit now, which is the same per-head idempotency proposals and claim markers use.
  describe("idempotency per head commit", () => {
    /** The peer answers the request, exactly as GitHub records it: the open request is cleared. */
    async function peerReviews(gh: FakeGitHubGateway, commitId: string, event: "APPROVE" | "COMMENT" = "APPROVE"): Promise<void> {
      const previous = gh.login;
      gh.login = "peer-bot";
      try {
        await gh.submitReview(REPO, PR, { commitId, event, body: "a look" });
      } finally {
        gh.login = previous;
      }
    }

    it("converges: the tick after the peer answers requests nothing, and a push starts a real round", async () => {
      const gh = seed();
      expect((await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"] })).status).toBe("requested");

      // Tick 2, same head. The peer has answered, so no request is outstanding any more.
      await peerReviews(gh, "sha0001");
      expect(await gh.listRequestedReviewers(REPO, PR)).toEqual({ users: [], teams: [] });
      expect((await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"] })).status).toBe("already-requested");
      expect(await gh.listRequestedReviewers(REPO, PR)).toEqual({ users: [], teams: [] }); // nothing re-requested

      // Tick 3, still the same head: still nothing. The loop does not restart on its own.
      expect((await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"] })).status).toBe("already-requested");
      expect(gh.reviews).toHaveLength(1);

      // The author pushes. THAT is a new round, and the peer is asked again.
      gh.prs.get(`${REPO}#${PR}`)!.headSha = "sha0002";
      expect((await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"] })).status).toBe("self-review-required");
      seedSelfReview(gh, "sha0002");
      expect((await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"] })).status).toBe("requested");
      expect((await gh.listRequestedReviewers(REPO, PR)).users).toEqual(["peer-bot"]);
    });

    it("counts a COMMENTED review at the head: a second opinion is still an answer to this diff", async () => {
      const gh = seed();
      await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"] });
      await peerReviews(gh, "sha0001", "COMMENT");
      expect((await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"] })).status).toBe("already-requested");
    });

    it("re-requests when the only review of the head is somebody else's", async () => {
      const gh = seed([TRIGGER]);
      gh.login = "carol";
      await gh.submitReview(REPO, PR, { commitId: "sha0001", event: "COMMENT", body: "drive-by" });
      gh.login = "me";
      expect((await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"] })).status).toBe("requested");
    });

    it("re-requests when the target reviewer's only review is of an earlier head", async () => {
      const gh = seed([TRIGGER]);
      await peerReviews(gh, "sha0000");
      expect((await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"] })).status).toBe("requested");
    });

    it("recognizes the answer whatever case the API spells the reviewer's login in", async () => {
      const gh = seed([TRIGGER]);
      gh.login = "Peer-Bot";
      await gh.submitReview(REPO, PR, { commitId: "sha0001", event: "APPROVE", body: "a look" });
      gh.login = "me";
      expect((await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"] })).status).toBe("already-requested");
    });

    it("still asks when the trigger label was removed, however the head was reviewed", async () => {
      // Both halves are required: without the label this pull request is not in the flow at all.
      const gh = seed();
      await peerReviews(gh, "sha0001");
      expect((await requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: ["peer-bot"] })).status).toBe("requested");
    });
  });

  it("errors when no reviewers were resolved", async () => {
    const gh = seed();
    await expect(requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: [] })).rejects.toThrow(/No reviewers/);
    expect((await gh.getPullRequest(REPO, PR)).labels).toEqual([]); // nothing was touched first
  });
});
