import { describe, it, expect } from "vitest";
import { protectionSatisfied, countApprovalsByOthers, sortReviews } from "./protection.js";
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
