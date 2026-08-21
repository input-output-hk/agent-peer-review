import { describe, it, expect } from "vitest";
import { protectionSatisfied, countApprovalsByOthers, hasStandingApproval, sortReviews } from "./protection.js";
import type { BranchProtectionSummary } from "../github.js";
import type { Review } from "../model.js";

const summary = (over: Partial<BranchProtectionSummary> = {}): BranchProtectionSummary => ({
  requiresPullRequestReviews: false,
  requiredApprovingReviewCount: 0,
  requiredChecks: [],
  enforceAdmins: false,
  requiresConversationResolution: false,
  ...over,
});

const green = { approvalsByOthers: 0, checksSummary: "green" } as const;

describe("protectionSatisfied", () => {
  it('"none" is satisfied: there is nothing to meet', () => {
    expect(protectionSatisfied("none", green)).toBe(true);
  });

  it('"unknown" fails closed: unreadable protection is not the same as absent protection', () => {
    expect(protectionSatisfied("unknown", green)).toBe(false);
  });

  it("an empty protection summary is satisfied", () => {
    expect(protectionSatisfied(summary(), green)).toBe(true);
  });

  describe("required conversation resolution", () => {
    it("always fails closed, even with everything else green", () => {
      expect(protectionSatisfied(summary({ requiresConversationResolution: true }), green)).toBe(false);
    });
  });

  describe("required checks", () => {
    it.each(["pending", "failing"] as const)("required checks with a %s rollup fail", (checksSummary) => {
      expect(protectionSatisfied(summary({ requiredChecks: ["build"] }), { approvalsByOthers: 0, checksSummary })).toBe(false);
    });

    it("required checks with a green rollup pass", () => {
      expect(protectionSatisfied(summary({ requiredChecks: ["build"] }), green)).toBe(true);
    });

    it("no required checks means the rollup does not matter to protection", () => {
      expect(protectionSatisfied(summary(), { approvalsByOthers: 0, checksSummary: "failing" })).toBe(true);
    });
  });

  describe("required approvals", () => {
    const needsTwo = summary({ requiresPullRequestReviews: true, requiredApprovingReviewCount: 2 });

    it("fails below the threshold", () => {
      expect(protectionSatisfied(needsTwo, { approvalsByOthers: 1, checksSummary: "green" })).toBe(false);
    });

    it("passes exactly at the threshold", () => {
      expect(protectionSatisfied(needsTwo, { approvalsByOthers: 2, checksSummary: "green" })).toBe(true);
    });

    it("passes above the threshold", () => {
      expect(protectionSatisfied(needsTwo, { approvalsByOthers: 5, checksSummary: "green" })).toBe(true);
    });

    it("a zero requirement is meaningful and satisfied by zero approvals", () => {
      const prRequired = summary({ requiresPullRequestReviews: true, requiredApprovingReviewCount: 0 });
      expect(protectionSatisfied(prRequired, green)).toBe(true);
    });

    it("the approval count is ignored when reviews are not required", () => {
      expect(protectionSatisfied(summary({ requiredApprovingReviewCount: 9 }), green)).toBe(true);
    });

    it("a malformed approval count fails closed rather than slipping past the comparison", () => {
      const prRequired = summary({ requiresPullRequestReviews: true, requiredApprovingReviewCount: 0 });
      expect(protectionSatisfied(prRequired, { approvalsByOthers: NaN, checksSummary: "green" })).toBe(false);
      expect(protectionSatisfied(prRequired, { approvalsByOthers: -1, checksSummary: "green" })).toBe(false);
    });
  });

  // The deliberate loosening from issue #48: the operation that SUPPLIES the approval must not be
  // blocked by the absence of its own approval. Every test here states one thing the flag does not
  // buy, because the whole safety argument is that it adds exactly one approval and relaxes nothing
  // else.
  describe("an approval the caller is about to submit", () => {
    const needsOne = summary({ requiresPullRequestReviews: true, requiredApprovingReviewCount: 1 });
    const needsTwo = summary({ requiresPullRequestReviews: true, requiredApprovingReviewCount: 2 });
    const pending = { approvalsByOthers: 0, checksSummary: "green", pendingApprovalFromActor: true } as const;

    it("satisfies a one-approval requirement that zero standing approvals cannot", () => {
      expect(protectionSatisfied(needsOne, green)).toBe(false); // the deadlock, without the flag
      expect(protectionSatisfied(needsOne, pending)).toBe(true);
    });

    it("adds exactly one, so a two-approval requirement with none standing still fails", () => {
      expect(protectionSatisfied(needsTwo, pending)).toBe(false);
      // A human's approval plus this one reaches two, which is the requirement being met, not bypassed.
      expect(protectionSatisfied(needsTwo, { ...pending, approvalsByOthers: 1 })).toBe(true);
    });

    it("is ignored when protection cannot be read at all", () => {
      expect(protectionSatisfied("unknown", pending)).toBe(false);
    });

    it("does not rescue a repository that requires conversation resolution", () => {
      const both = summary({ requiresPullRequestReviews: true, requiredApprovingReviewCount: 1, requiresConversationResolution: true });
      expect(protectionSatisfied(both, pending)).toBe(false);
    });

    it.each(["pending", "failing"] as const)("does not rescue a %s required check", (checksSummary) => {
      const both = summary({ requiresPullRequestReviews: true, requiredApprovingReviewCount: 1, requiredChecks: ["build"] });
      expect(protectionSatisfied(both, { ...pending, checksSummary })).toBe(false);
    });

    it.each([NaN, -1, 0.5, Infinity])("does not rescue a malformed approval count (%s)", (approvalsByOthers) => {
      // The guards run BEFORE the increment on purpose: NaN + 1 >= 1 is false anyway, but -1 + 1 >= 0
      // would be true, so a bogus count must be rejected on its own terms rather than repaired.
      expect(protectionSatisfied(needsOne, { ...pending, approvalsByOthers })).toBe(false);
      const zeroRequired = summary({ requiresPullRequestReviews: true, requiredApprovingReviewCount: 0 });
      expect(protectionSatisfied(zeroRequired, { ...pending, approvalsByOthers })).toBe(false);
    });

    it("does not rescue a malformed requirement", () => {
      const bogus = summary({ requiresPullRequestReviews: true, requiredApprovingReviewCount: NaN });
      expect(protectionSatisfied(bogus, pending)).toBe(false);
    });

    it("false and omitted are the same thing: the non-approving caller's behavior is untouched", () => {
      expect(protectionSatisfied(needsOne, { approvalsByOthers: 0, checksSummary: "green", pendingApprovalFromActor: false })).toBe(false);
      expect(protectionSatisfied(needsOne, { approvalsByOthers: 1, checksSummary: "green", pendingApprovalFromActor: false })).toBe(true);
    });

    it("changes nothing where reviews are not required", () => {
      expect(protectionSatisfied(summary({ requiredApprovingReviewCount: 9 }), pending)).toBe(true);
      expect(protectionSatisfied("none", pending)).toBe(true);
    });
  });
});

let reviewSeq = 0;
// Ids and timestamps ascend together, so "chronological" is unambiguous and a test can hand the
// list over in any order.
const rev = (author: string, state: string): Review => {
  const n = ++reviewSeq;
  return { id: n, author, state, body: "", commitId: "abc1234", submittedAt: `2026-08-07T10:00:${String(n).padStart(2, "0")}Z` };
};

describe("countApprovalsByOthers", () => {
  it("counts one approval per distinct login", () => {
    expect(countApprovalsByOthers([rev("alice", "APPROVED"), rev("alice", "APPROVED"), rev("bob", "APPROVED")], "author")).toBe(2);
  });

  it("ignores the pull request author's own approval", () => {
    expect(countApprovalsByOthers([rev("author", "APPROVED"), rev("alice", "APPROVED")], "author")).toBe(1);
  });

  it("a later CHANGES_REQUESTED cancels an earlier approval by the same login", () => {
    expect(countApprovalsByOthers([rev("alice", "APPROVED"), rev("alice", "CHANGES_REQUESTED")], "author")).toBe(0);
  });

  it("a later approval replaces an earlier CHANGES_REQUESTED", () => {
    expect(countApprovalsByOthers([rev("alice", "CHANGES_REQUESTED"), rev("alice", "APPROVED")], "author")).toBe(1);
  });

  it("a DISMISSED review cancels the approval it replaced", () => {
    expect(countApprovalsByOthers([rev("alice", "APPROVED"), rev("alice", "DISMISSED")], "author")).toBe(0);
  });

  it("a COMMENTED review left after an approval does not withdraw it", () => {
    expect(countApprovalsByOthers([rev("alice", "APPROVED"), rev("alice", "COMMENTED")], "author")).toBe(1);
  });

  it("comments alone are not approvals", () => {
    expect(countApprovalsByOthers([rev("alice", "COMMENTED")], "author")).toBe(0);
  });

  it("is zero for no reviews", () => {
    expect(countApprovalsByOthers([], "author")).toBe(0);
  });

  // The standing verdict is decided from submittedAt, not from the order the list arrived in, so a
  // gateway that ever returns newest-first cannot silently resurrect a withdrawn approval.
  it("uses submission time, not array order, to find the standing verdict", () => {
    const approved = rev("alice", "APPROVED");
    const withdrawn = rev("alice", "CHANGES_REQUESTED"); // later
    expect(countApprovalsByOthers([approved, withdrawn], "author")).toBe(0);
    expect(countApprovalsByOthers([withdrawn, approved], "author")).toBe(0); // same answer reversed
  });

  it("breaks a submittedAt tie with the review id", () => {
    const sameTime = "2026-08-07T10:00:00Z";
    const first: Review = { id: 1, author: "alice", state: "CHANGES_REQUESTED", body: "", commitId: "c", submittedAt: sameTime };
    const second: Review = { id: 2, author: "alice", state: "APPROVED", body: "", commitId: "c", submittedAt: sameTime };
    expect(countApprovalsByOthers([second, first], "author")).toBe(1); // id 2 is the later one
  });
});

// The other half of the double-count guard: countApprovalsByOthers says how many approvals are
// already counted, and this says whether a specific login's is one of them.
describe("hasStandingApproval", () => {
  it("is true for a login whose latest verdict is an approval", () => {
    expect(hasStandingApproval([rev("me", "APPROVED")], "me")).toBe(true);
  });

  it("is false for a login with no reviews at all", () => {
    expect(hasStandingApproval([rev("alice", "APPROVED")], "me")).toBe(false);
    expect(hasStandingApproval([], "me")).toBe(false);
  });

  it("follows the same standing-verdict rule as the count: a later verdict replaces an earlier one", () => {
    expect(hasStandingApproval([rev("me", "APPROVED"), rev("me", "CHANGES_REQUESTED")], "me")).toBe(false);
    expect(hasStandingApproval([rev("me", "APPROVED"), rev("me", "DISMISSED")], "me")).toBe(false);
    expect(hasStandingApproval([rev("me", "CHANGES_REQUESTED"), rev("me", "APPROVED")], "me")).toBe(true);
    expect(hasStandingApproval([rev("me", "APPROVED"), rev("me", "COMMENTED")], "me")).toBe(true);
  });

  it("uses submission time rather than array order", () => {
    const approved = rev("me", "APPROVED");
    const withdrawn = rev("me", "CHANGES_REQUESTED"); // later
    expect(hasStandingApproval([withdrawn, approved], "me")).toBe(false);
  });

  // The one comparison in this loosening that could fail OPEN. countApprovalsByOthers counts
  // whatever login the API returned, so an exact match here would answer "no approval yet" for an
  // approval already inside that count, and rail 5 would add a second one for the same person.
  // GitHub logins are unique case-insensitively, so the two spellings are one account.
  it("matches a login whose case differs from the review's, so one approval is never counted twice", () => {
    const approved: Review = { id: 1, author: "Me", state: "APPROVED", body: "", commitId: "c", submittedAt: "2026-08-07T09:00:00Z" };
    expect(hasStandingApproval([approved], "me")).toBe(true);
    expect(countApprovalsByOthers([approved], "the-author")).toBe(1); // the same approval, once
    // The same insensitivity excludes the pull request author's own approval however it was spelled,
    // which is the conservative direction: a lower count, never a higher one.
    expect(countApprovalsByOthers([approved], "mE")).toBe(0);
  });

  // An approval left on an earlier commit still counts toward branch protection, and
  // countApprovalsByOthers counts it too, so this must agree with it or the pending-approval
  // increment would count the same approval twice.
  it("does not care which commit the approval was left on", () => {
    const old: Review = { id: 1, author: "me", state: "APPROVED", body: "", commitId: "an-older-sha", submittedAt: "2026-08-07T09:00:00Z" };
    expect(hasStandingApproval([old], "me")).toBe(true);
    expect(countApprovalsByOthers([old], "the-author")).toBe(1);
  });
});

describe("sortReviews", () => {
  it("orders oldest to newest and does not mutate its input", () => {
    const a = rev("alice", "APPROVED");
    const b = rev("bob", "APPROVED");
    const input = [b, a];
    expect(sortReviews(input).map((r) => r.id)).toEqual([a.id, b.id]);
    expect(input.map((r) => r.id)).toEqual([b.id, a.id]);
  });

  it("sorts a never-submitted review first rather than treating it as newest", () => {
    const submitted = rev("alice", "APPROVED");
    const pending: Review = { id: 999, author: "alice", state: "PENDING", body: "", commitId: "c", submittedAt: "" };
    expect(sortReviews([submitted, pending]).map((r) => r.id)).toEqual([pending.id, submitted.id]);
  });
});
