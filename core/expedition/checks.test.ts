import { describe, it, expect } from "vitest";
import { summarizeChecks } from "./checks.js";
import { UNREADABLE_CHECKS, type CheckResult } from "../github.js";

const check = (name: string, status: CheckResult["status"]): CheckResult => ({ name, status });

describe("summarizeChecks", () => {
  describe("without required contexts (every result is judged)", () => {
    it("no results at all is green (a repository that runs no checks has nothing that can fail)", () => {
      expect(summarizeChecks([])).toBe("green");
      expect(summarizeChecks([], [])).toBe("green"); // an empty required list is the same as none
    });

    it("all successes is green", () => {
      expect(summarizeChecks([check("build", "success"), check("lint", "success")])).toBe("green");
    });

    it("neutral counts as success", () => {
      expect(summarizeChecks([check("build", "success"), check("skipped-job", "neutral")])).toBe("green");
      expect(summarizeChecks([check("skipped-job", "neutral")])).toBe("green");
    });

    it("any pending holds the rollup at pending", () => {
      expect(summarizeChecks([check("build", "success"), check("e2e", "pending")])).toBe("pending");
    });

    it("any failure wins over pending", () => {
      expect(summarizeChecks([check("build", "failure"), check("e2e", "pending")])).toBe("failing");
    });
  });

  describe("with required contexts (only those are judged)", () => {
    const results = [check("build", "success"), check("optional-perf", "failure"), check("flaky", "pending")];

    it("ignores non-required results, however red", () => {
      expect(summarizeChecks(results, ["build"])).toBe("green");
    });

    it("a required context missing from the results is pending, never green", () => {
      expect(summarizeChecks([check("build", "success")], ["build", "never-reported"])).toBe("pending");
    });

    it("a missing required context is pending even when nothing has reported at all", () => {
      expect(summarizeChecks([], ["build"])).toBe("pending");
    });

    it("a failing required context is failing", () => {
      expect(summarizeChecks(results, ["build", "optional-perf"])).toBe("failing");
    });

    it("a failing required context beats a missing one", () => {
      expect(summarizeChecks(results, ["optional-perf", "never-reported"])).toBe("failing");
    });

    it("judges every result sharing a required name, so the worst one wins", () => {
      const duplicated = [check("build", "success"), check("build", "failure")];
      expect(summarizeChecks(duplicated, ["build"])).toBe("failing");
    });

    it("a required context that is neutral counts as satisfied", () => {
      expect(summarizeChecks([check("build", "neutral")], ["build"])).toBe("green");
    });

    it("fails closed on an unreadable-checks sentinel even when it is not a required context", () => {
      expect(summarizeChecks([check("build", "success"), check(UNREADABLE_CHECKS, "failure")], ["build"]))
        .toBe("failing");
    });
  });
});
