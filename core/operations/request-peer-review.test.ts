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

  it("errors when no reviewers were resolved", async () => {
    const gh = seed();
    await expect(requestPeerReview(gh, { repo: REPO, pr: PR, reviewers: [] })).rejects.toThrow(/No reviewers/);
    expect((await gh.getPullRequest(REPO, PR)).labels).toEqual([]); // nothing was touched first
  });
});
