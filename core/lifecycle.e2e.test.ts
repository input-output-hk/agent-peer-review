import { describe, it, expect } from "vitest";
import { FakeGitHubGateway } from "../test/fakes/fake-github.js";
import { createReview } from "./operations/create.js";
import { listReviews } from "./operations/list.js";
import { claimReview } from "./operations/claim.js";
import { completeReview } from "./operations/complete.js";
import { enrichReview } from "./operations/enrich.js";
import { PRIMARY_MARKER } from "./claim-marker.js";

const cfg = { githubLogin: null as string | null, skillsDir: null, runChecks: false };
const TTL = 30 * 60_000;

describe("lifecycle e2e", () => {
  it("single reviewer: create, list, claim, complete", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 20, title: "t", author: "author", headSha: "sha00020", baseSha: "b", url: "u", state: "open", labels: [] });

    await createReview(gh, { repo: "o/r", pr: 20, skills: [], reviewers: ["me"] });

    const beforeClaim = await listReviews(gh, { repo: "o/r", login: "me" });
    expect(beforeClaim).toHaveLength(1);
    expect(beforeClaim[0].claim).toBeUndefined(); // no claim yet

    const task = await claimReview({ gh, config: cfg, machine: "m1", now: "2026-07-30T00:00:00Z" }, { repo: "o/r", pr: 20 });
    expect(task.role).toBe("anchor");
    expect(task.headSha).toBe("sha00020"); // pins the head SHA
    expect(await gh.listComments("o/r", 20)).toHaveLength(1); // marker posted

    const res = await completeReview({ gh, config: cfg }, { repo: "o/r", pr: 20, event: "approve", summary: "looks good" });
    expect(res.drifted).toBe(false);
    expect(res.superseded).toBe(false);

    const reviews = await gh.getReviews("o/r", 20);
    expect(reviews).toHaveLength(1); // exactly one review
    expect(reviews[0]).toMatchObject({ author: "me", state: "APPROVED", commitId: "sha00020" }); // event maps correctly
    expect(await gh.listReviewRequests("o/r", "me")).toHaveLength(0); // request cleared
    expect(await gh.listComments("o/r", 20)).toHaveLength(0); // no markers remain
  });

  it("panel: alice anchors, bob enriches after alice's primary", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 21, title: "t", author: "author", headSha: "sha00021", baseSha: "b", url: "u", state: "open", labels: [] });

    await createReview(gh, { repo: "o/r", pr: 21, skills: [], reviewers: ["alice", "bob"] });

    gh.login = "alice";
    const aliceTask = await claimReview({ gh, config: cfg, machine: "m1", now: "2026-07-30T00:00:00Z" }, { repo: "o/r", pr: 21 });
    expect(aliceTask.role).toBe("anchor");

    gh.login = "bob";
    const bobTask = await claimReview({ gh, config: cfg, machine: "m2", now: "2026-07-30T00:01:00Z" }, { repo: "o/r", pr: 21 });
    expect(bobTask.role).toBe("enricher");

    gh.login = "alice";
    const completeRes = await completeReview({ gh, config: cfg }, { repo: "o/r", pr: 21, event: "request-changes", summary: "fix the thing" });
    expect(completeRes.superseded).toBe(false); // alice is first, so this is the primary

    gh.login = "bob";
    const enrichRes = await enrichReview(
      { gh, config: cfg, ttlMs: TTL, nowMs: Date.parse("2026-07-30T00:02:00Z") },
      { repo: "o/r", pr: 21, overallVerdict: "agree", summary: "confirmed" },
    );
    expect(enrichRes.status).toBe("enriched"); // primary already exists

    const reviews = await gh.getReviews("o/r", 21);
    // Count primaries by the primary tag, not by review state: a legitimate anchor whose verdict
    // is "comment" would also be COMMENTED, so state alone would miscount.
    const primaries = reviews.filter((r) => r.body.includes(PRIMARY_MARKER));
    const secondOpinions = reviews.filter((r) => !r.body.includes(PRIMARY_MARKER));
    expect(primaries).toHaveLength(1); // exactly one tagged primary review
    expect(primaries[0]).toMatchObject({ author: "alice", commitId: "sha00021" });
    expect(secondOpinions).toHaveLength(1); // one second opinion (untagged COMMENT)
    expect(secondOpinions[0]).toMatchObject({ author: "bob", commitId: "sha00021" }); // at the primary's commit

    expect(await gh.listComments("o/r", 21)).toHaveLength(0); // no markers remain
    expect(await gh.listReviewRequests("o/r", "alice")).toHaveLength(0); // both requests cleared
    expect(await gh.listReviewRequests("o/r", "bob")).toHaveLength(0);
  });
});
