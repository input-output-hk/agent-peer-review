import { describe, it, expect } from "vitest";
import { evaluateGates, DEFAULT_GATE_POLICY, type GateInput } from "./gate.js";
import { classifyChange } from "./classify.js";

// A fully clean, auto-eligible baseline. Each rail test below overrides exactly one field so the
// test proves that flipping ONLY that rail is what forces "propose".
function baseInput(overrides: Partial<GateInput> = {}): GateInput {
  return {
    classification: classifyChange(["README.md"]),
    changedFiles: 1,
    changedLines: 3,
    checks: "green",
    mergeableState: "clean",
    branchProtectionSatisfied: true,
    hasNewSecurityAlert: false,
    humanReviewPending: false,
    humanChangesRequested: false,
    autonomy: "auto",
    headShaGuardPassed: true,
    actingLogin: "agent-bot",
    author: "human-author",
    isApproving: false,
    ...overrides,
  };
}

describe("evaluateGates", () => {
  it("DEFAULT_GATE_POLICY is 10 files / 200 lines", () => {
    expect(DEFAULT_GATE_POLICY).toEqual({ maxFiles: 10, maxLines: 200 });
  });

  it("a fully clean auto-eligible input returns auto with no reasons", () => {
    expect(evaluateGates(baseInput())).toEqual({ action: "auto", reasons: [] });
  });

  describe("rail 1: classification.autoEligible", () => {
    it("a source path in the diff forces propose and names the offending file", () => {
      const decision = evaluateGates(baseInput({ classification: classifyChange(["README.md", "src/index.ts"]) }));
      expect(decision.action).toBe("propose");
      expect(decision.reasons).toHaveLength(1);
      expect(decision.reasons[0]).toContain("src/index.ts");
      expect(decision.reasons[0]).toContain("source");
    });

    it("a test path in the diff forces propose and names the offending file", () => {
      const decision = evaluateGates(baseInput({ classification: classifyChange(["README.md", "src/index.test.ts"]) }));
      expect(decision.action).toBe("propose");
      expect(decision.reasons).toHaveLength(1);
      expect(decision.reasons[0]).toContain("src/index.test.ts");
      expect(decision.reasons[0]).toContain("test");
    });

    it("an empty changed-file list forces propose with a distinct reason", () => {
      const decision = evaluateGates(baseInput({ classification: classifyChange([]) }));
      expect(decision.action).toBe("propose");
      expect(decision.reasons).toHaveLength(1);
      expect(decision.reasons[0]).toContain("no changed files");
    });
  });

  describe("rail 2: size caps", () => {
    it("changedFiles exactly at the cap passes", () => {
      expect(evaluateGates(baseInput({ changedFiles: DEFAULT_GATE_POLICY.maxFiles })).action).toBe("auto");
    });

    it("changedFiles one over the cap fails", () => {
      const decision = evaluateGates(baseInput({ changedFiles: DEFAULT_GATE_POLICY.maxFiles + 1 }));
      expect(decision.action).toBe("propose");
      expect(decision.reasons).toHaveLength(1);
      expect(decision.reasons[0]).toContain("too many changed files");
    });

    it("changedLines exactly at the cap passes", () => {
      expect(evaluateGates(baseInput({ changedLines: DEFAULT_GATE_POLICY.maxLines })).action).toBe("auto");
    });

    it("changedLines one over the cap fails", () => {
      const decision = evaluateGates(baseInput({ changedLines: DEFAULT_GATE_POLICY.maxLines + 1 }));
      expect(decision.action).toBe("propose");
      expect(decision.reasons).toHaveLength(1);
      expect(decision.reasons[0]).toContain("too many changed lines");
    });

    it("exceeding both caps at once still yields a single rail-2 reason mentioning both", () => {
      const decision = evaluateGates(baseInput({ changedFiles: 11, changedLines: 201 }));
      expect(decision.action).toBe("propose");
      expect(decision.reasons).toHaveLength(1);
      expect(decision.reasons[0]).toContain("too many changed files");
      expect(decision.reasons[0]).toContain("too many changed lines");
    });

    it("a partial policy override merges with the default for the untouched field", () => {
      const decision = evaluateGates(baseInput({ changedFiles: 3, policy: { maxFiles: 2 } }));
      expect(decision.action).toBe("propose");
      expect(decision.reasons).toHaveLength(1);
      expect(decision.reasons[0]).toContain("too many changed files (3 > 2)");
      expect(decision.reasons[0]).not.toContain("lines"); // maxLines still defaults to 200, not exceeded
    });

    // Fail-closed regression coverage: a bare `n > cap` comparison fails OPEN on a negative or
    // non-numeric count (e.g. -5 > 10 is false), silently passing malformed data through this
    // rail. These pin that a count must be a non-negative integer to pass at all.
    it("a negative changedFiles count forces propose instead of silently passing", () => {
      const decision = evaluateGates(baseInput({ changedFiles: -5 }));
      expect(decision.action).toBe("propose");
      expect(decision.reasons).toHaveLength(1);
      expect(decision.reasons[0]).toContain("invalid");
    });

    it("a NaN changedLines count forces propose instead of silently passing", () => {
      const decision = evaluateGates(baseInput({ changedLines: NaN }));
      expect(decision.action).toBe("propose");
      expect(decision.reasons).toHaveLength(1);
      expect(decision.reasons[0]).toContain("invalid");
    });

    it("a non-integer changedFiles count forces propose", () => {
      const decision = evaluateGates(baseInput({ changedFiles: 2.5 }));
      expect(decision.action).toBe("propose");
      expect(decision.reasons).toHaveLength(1);
      expect(decision.reasons[0]).toContain("invalid");
    });

    it("a negative changedLines count and an over-cap changedFiles count both surface in one rail-2 reason", () => {
      const decision = evaluateGates(baseInput({ changedFiles: 11, changedLines: -1 }));
      expect(decision.action).toBe("propose");
      expect(decision.reasons).toHaveLength(1);
      expect(decision.reasons[0]).toContain("too many changed files");
      expect(decision.reasons[0]).toContain("invalid");
    });
  });

  describe("rail 3: checks", () => {
    it.each(["pending", "failing"] as const)("checks:%s forces propose", (checks) => {
      const decision = evaluateGates(baseInput({ checks }));
      expect(decision.action).toBe("propose");
      expect(decision.reasons).toHaveLength(1);
      expect(decision.reasons[0]).toContain(checks);
    });
  });

  describe("rail 4: mergeableState", () => {
    it.each(["dirty", "behind", "blocked", "unstable", "unknown"] as const)("mergeableState:%s forces propose", (mergeableState) => {
      const decision = evaluateGates(baseInput({ mergeableState }));
      expect(decision.action).toBe("propose");
      expect(decision.reasons).toHaveLength(1);
      expect(decision.reasons[0]).toContain(mergeableState);
    });

    // The narrow exception. GitHub reports "blocked" for an open pull request whose base branch
    // requires an approving review while none stands, so without this the operation that supplies the
    // missing review cannot pass a rail that is failing because the review is missing: the same
    // deadlock rail 5 had, one rail over.
    describe('"blocked" and the approval that is about to remove the block', () => {
      const approving = { isApproving: true, pendingApprovalFromActor: true, author: "someone-else" } as const;

      it("passes for the approver that is about to supply the missing review", () => {
        expect(evaluateGates(baseInput({ mergeableState: "blocked", ...approving })).action).toBe("auto");
      });

      it("still fails when nobody is supplying an approval", () => {
        // What expedite passes: it merges rather than approves, so it never claims this.
        const merging = evaluateGates(baseInput({ mergeableState: "blocked", isApproving: false }));
        expect(merging.action).toBe("propose");
        expect(merging.reasons).toEqual(["mergeable state is blocked (need clean)"]);
      });

      it("still fails when the claim is made without approving, or approving without the claim", () => {
        // Both halves are required, so neither field alone can unlock the rail.
        expect(evaluateGates(baseInput({ mergeableState: "blocked", isApproving: false, pendingApprovalFromActor: true })).action).toBe("propose");
        expect(evaluateGates(baseInput({ mergeableState: "blocked", isApproving: true, pendingApprovalFromActor: false, author: "someone-else" })).action).toBe("propose");
      });

      // The tolerance is for one state and one cause. Everything else GitHub can report still fails,
      // including "unknown", where nothing is known and so nothing is assumed.
      it.each(["dirty", "behind", "unstable", "unknown"] as const)("does not extend to mergeableState:%s", (mergeableState) => {
        const decision = evaluateGates(baseInput({ mergeableState, ...approving }));
        expect(decision.action).toBe("propose");
        expect(decision.reasons).toEqual([`mergeable state is ${mergeableState} (need clean)`]);
      });

      it("does not rescue a self-approval: rail 10 still fires and the change still proposes", () => {
        const decision = evaluateGates(baseInput({
          mergeableState: "blocked", isApproving: true, pendingApprovalFromActor: true,
          actingLogin: "me", author: "me",
        }));
        expect(decision.action).toBe("propose");
        expect(decision.reasons.some((r) => r.includes("self-approval"))).toBe(true);
      });
    });
  });

  describe("rail 5: branchProtectionSatisfied", () => {
    it("false forces propose", () => {
      const decision = evaluateGates(baseInput({ branchProtectionSatisfied: false }));
      expect(decision.action).toBe("propose");
      expect(decision.reasons).toHaveLength(1);
      expect(decision.reasons[0]).toContain("branch protection");
    });
  });

  describe("rail 6: hasNewSecurityAlert", () => {
    it("true forces propose", () => {
      const decision = evaluateGates(baseInput({ hasNewSecurityAlert: true }));
      expect(decision.action).toBe("propose");
      expect(decision.reasons).toHaveLength(1);
      expect(decision.reasons[0]).toContain("security alert");
    });
  });

  // Issue #57: this rail used to take one boolean that was true as soon as any human had left any
  // review, in any state. A GitHub review is permanent history, so on any repository that requires an
  // approving review the review that satisfied rail 5 was the same event that failed this rail, and
  // the auto path was unreachable. The two facts it really asks about are separate inputs now, with a
  // reason each.
  describe("rail 7: a human mid-review, and a human's standing refusal", () => {
    it("a pending human review forces propose, and says a review is in flight", () => {
      const decision = evaluateGates(baseInput({ humanReviewPending: true }));
      expect(decision.action).toBe("propose");
      expect(decision.reasons).toEqual(["a human review is in flight"]);
    });

    it("a human's standing CHANGES_REQUESTED forces propose, with its own reason", () => {
      const decision = evaluateGates(baseInput({ humanChangesRequested: true }));
      expect(decision.action).toBe("propose");
      expect(decision.reasons).toEqual(["a human has requested changes"]);
      // The wording matters as much as the refusal: a proposal comment claiming somebody is mid-review
      // when they have finished and said no is a comment that misinforms the maintainer reading it.
      expect(decision.reasons[0]).not.toContain("in flight");
    });

    it("both at once stay one rail, and name both causes", () => {
      const decision = evaluateGates(baseInput({ humanReviewPending: true, humanChangesRequested: true }));
      expect(decision.reasons).toEqual(["a human review is in flight; a human has requested changes"]);
    });

    // The regression guard for the deadlock itself, at the gate's own level: neither half may be
    // inferred from anything else. A finished, favourable human review reaches this function as
    // nothing at all, and the gate says auto.
    it("neither half fires on its own baseline: a finished human review is not an obstacle here", () => {
      expect(evaluateGates(baseInput())).toEqual({ action: "auto", reasons: [] });
      expect(evaluateGates(baseInput({ humanReviewPending: false, humanChangesRequested: false })))
        .toEqual({ action: "auto", reasons: [] });
    });
  });

  describe("rail 8: autonomy", () => {
    it('"propose" alone forces propose, even with every other rail clean', () => {
      const decision = evaluateGates(baseInput({ autonomy: "propose" }));
      expect(decision.action).toBe("propose");
      expect(decision.reasons).toHaveLength(1);
      expect(decision.reasons[0]).toContain("autonomy");
    });
  });

  describe("rail 9: headShaGuardPassed", () => {
    it("false forces propose", () => {
      const decision = evaluateGates(baseInput({ headShaGuardPassed: false }));
      expect(decision.action).toBe("propose");
      expect(decision.reasons).toHaveLength(1);
      expect(decision.reasons[0]).toContain("head SHA guard");
    });
  });

  describe("rail 10: self-approval", () => {
    it("isApproving with actingLogin === author forces propose", () => {
      const decision = evaluateGates(baseInput({ isApproving: true, actingLogin: "same-login", author: "same-login" }));
      expect(decision.action).toBe("propose");
      expect(decision.reasons).toHaveLength(1);
      expect(decision.reasons[0]).toContain("self-approval");
    });

    it("isApproving with a different actingLogin still passes", () => {
      const decision = evaluateGates(baseInput({ isApproving: true, actingLogin: "agent-bot", author: "human-author" }));
      expect(decision).toEqual({ action: "auto", reasons: [] });
    });

    it("the rail applies only when isApproving; the same login is fine when not approving", () => {
      const decision = evaluateGates(baseInput({ isApproving: false, actingLogin: "same-login", author: "same-login" }));
      expect(decision).toEqual({ action: "auto", reasons: [] });
    });
  });

  it("multiple simultaneous failures accumulate multiple reasons", () => {
    const decision = evaluateGates(baseInput({ checks: "failing", mergeableState: "dirty", hasNewSecurityAlert: true }));
    expect(decision.action).toBe("propose");
    expect(decision.reasons).toHaveLength(3);
    expect(decision.reasons.some((r) => r.includes("checks"))).toBe(true);
    expect(decision.reasons.some((r) => r.includes("mergeable state"))).toBe(true);
    expect(decision.reasons.some((r) => r.includes("security alert"))).toBe(true);
  });

  it("every rail failing at once reports ten reasons", () => {
    const decision = evaluateGates({
      classification: classifyChange(["src/index.ts"]),
      changedFiles: 999,
      changedLines: 999,
      checks: "failing",
      mergeableState: "dirty",
      branchProtectionSatisfied: false,
      hasNewSecurityAlert: true,
      // Both halves of rail 7 at once, which is still one rail and one reason: the count below is the
      // number of RAILS that can refuse, not the number of facts they are read from.
      humanReviewPending: true,
      humanChangesRequested: true,
      autonomy: "propose",
      headShaGuardPassed: false,
      actingLogin: "same-login",
      author: "same-login",
      isApproving: true,
    });
    expect(decision.action).toBe("propose");
    expect(decision.reasons).toHaveLength(10);
  });
});
