import { describe, expect, it } from "vitest";
import { PRIMARY_MARKER } from "./claim-marker.js";
import { ReviewResultSchema, type Review, type ReviewFinding, type ReviewHistory } from "./model.js";
import {
  buildReviewHistory,
  parseReviewRecord,
  serializeReviewRecord,
  type ReviewRecord,
  validateFindingProgress,
  validateNewFindingAdmissibility,
} from "./review-record.js";

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
  id: "shell-policy-parser",
  title: "Policy requires an unbounded shell interpreter",
  severity: "high",
  confidence: "confirmed",
  scope: "introduced",
  status: "open",
  blocking: true,
  path: "src/policy.ts",
  line: 42,
  evidence: "A bounded corpus reproduces wrapper, quoting, and command-substitution variants.",
  remediation: "Narrow the policy or use an established parser.",
  ...over,
});

const review = (
  id: number,
  commitId: string,
  verdict: ReviewRecord["verdict"],
  findings: ReviewFinding[],
  state = "CHANGES_REQUESTED",
): Review => ({
  id,
  author: "review-bot",
  state,
  commitId,
  submittedAt: `2026-08-${String(id).padStart(2, "0")}T00:00:00Z`,
  body: `${serializeReviewRecord({
    v: 1, reviewedSha: commitId, mode: id === 1 ? "initial" : "rereview",
    role: "primary", verdict, findings,
  })}\n\n${PRIMARY_MARKER}`,
});

const history = (over: Partial<ReviewHistory> = {}): ReviewHistory => ({
  mode: "rereview",
  changesRequestedCycles: 1,
  reviewedShas: ["sha0001"],
  findings: [],
  acceptedRisks: [],
  lastVerdict: "request-changes",
  truncated: false,
  ...over,
});

describe("structured review records and convergence", () => {
  it("round-trips structured records and consolidates shell variants into one root-cause family", () => {
    const rootCause = finding();
    const marker = serializeReviewRecord({
      v: 1, reviewedSha: "sha0001", mode: "initial", role: "primary",
      verdict: "request-changes", findings: [rootCause],
    });
    expect(parseReviewRecord(marker)?.findings).toEqual([rootCause]);
    expect(parseReviewRecord(marker)?.findings).toHaveLength(1);

    const duplicate = ReviewResultSchema.safeParse({
      repo: "o/r", pr: 1, event: "request-changes", summary: "same parser root cause",
      reviewedSha: "sha0001", findings: [rootCause, { ...rootCause, evidence: "one more quoting form" }],
    });
    expect(duplicate.success).toBe(false);
    expect(duplicate.error?.issues.some((issue) => issue.message.includes("duplicate finding id"))).toBe(true);
  });

  it("ignores a structured record whose asserted reviewed SHA differs from GitHub's review commit", () => {
    const stale = review(1, "sha0001", "request-changes", [finding()]);
    stale.body = `${serializeReviewRecord({
      v: 1, reviewedSha: "sha9999", mode: "initial", role: "primary",
      verdict: "request-changes", findings: [finding()],
    })}\n\n${PRIMARY_MARKER}`;

    const result = buildReviewHistory([stale], "sha0002");

    expect(result.reviewedShas).toEqual(["sha0001"]);
    expect(result.findings).toEqual([]);
  });

  it("allows approval after prior blockers resolve while unrelated pre-existing debt stays non-blocking", () => {
    const prior = history({
      findings: [{
        id: "original", title: "Original blocker", severity: "high", scope: "introduced",
        status: "open", blocking: true, relatedFindingId: null, followUpIssue: null,
      }],
    });
    expect(() => validateFindingProgress([
      finding({ id: "original", status: "resolved", blocking: false }),
      finding({
        id: "old-cleanup", title: "Old cleanup debt", severity: "medium", confidence: "high",
        scope: "pre-existing", status: "follow-up", blocking: false,
      }),
    ], prior, "rereview")).not.toThrow();
  });

  it("treats uncancellable lock expiry as an accepted safety decision and requires new evidence to reopen it", () => {
    const accepted = history({
      findings: [{
        id: "uncancellable-lock", title: "Elapsed lock expiry", severity: "high", scope: "accepted-risk",
        status: "accepted-risk", blocking: false, relatedFindingId: null, followUpIssue: null,
      }],
      acceptedRisks: [{
        id: "uncancellable-lock", title: "Elapsed lock expiry", severity: "high", scope: "accepted-risk",
        status: "accepted-risk", blocking: false, relatedFindingId: null, followUpIssue: null,
      }],
    });
    const reopened = finding({ id: "uncancellable-lock", scope: "regression", status: "regressed" });
    expect(() => validateFindingProgress([reopened], accepted, "rereview")).toThrow(/requires new evidence/);
    expect(() => validateFindingProgress([
      { ...reopened, reopenedBecause: "The new commit makes the underlying operation cancellable." },
    ], accepted, "rereview")).not.toThrow();
  });

  it("enters convergence after two changes-requested cycles and keeps history bounded", () => {
    const reviews: Review[] = [];
    for (let index = 1; index <= 15; index += 1) {
      reviews.push(review(index, `sha${String(index).padStart(4, "0")}`, "request-changes", [
        finding({ id: `family-${index}-a` }),
        finding({ id: `family-${index}-b` }),
        finding({ id: `family-${index}-c` }),
      ]));
    }
    const result = buildReviewHistory(reviews, "sha9999");
    expect(result.mode).toBe("convergence");
    expect(result.changesRequestedCycles).toBe(15);
    expect(result.reviewedShas).toHaveLength(12);
    expect(result.findings).toHaveLength(30);
    expect(result.truncated).toBe(true);
  });

  it("counts one changes-requested cycle per head and preserves bounded accepted safety decisions", () => {
    const accepted = finding({
      id: "integrity-lock", scope: "accepted-risk", status: "accepted-risk", blocking: false,
    });
    const reviews = [
      review(1, "sha0001", "request-changes", [accepted]),
      review(2, "sha0001", "request-changes", [accepted]),
    ];
    for (let index = 3; index <= 35; index += 1) {
      reviews.push(review(index, `sha${String(index).padStart(4, "0")}`, "comment", [
        finding({ id: `later-${index}`, blocking: false, status: "resolved" }),
      ], "COMMENTED"));
    }

    const result = buildReviewHistory(reviews, "sha9999");

    expect(result.changesRequestedCycles).toBe(1);
    expect(result.mode).toBe("rereview");
    expect(result.findings.some((item) => item.id === "integrity-lock")).toBe(false);
    expect(result.acceptedRisks.map((item) => item.id)).toContain("integrity-lock");
    expect(() => validateFindingProgress([
      finding({ id: "integrity-lock", scope: "regression", status: "regressed" }),
    ], result, "rereview")).toThrow(/requires new evidence/);
  });

  it("allows a genuinely new high regression to block in convergence but rejects adjacent medium hardening", () => {
    const converging = history({ mode: "convergence", changesRequestedCycles: 2 });
    expect(() => validateNewFindingAdmissibility([
      finding({ id: "fix-regression", scope: "regression", severity: "high" }),
    ], converging, "convergence")).not.toThrow();
    expect(() => validateNewFindingAdmissibility([
      finding({ id: "adjacent-hardening", severity: "medium" }),
    ], converging, "convergence")).toThrow(/critical\/high/);
  });

  it("rejects request-changes without a confirmed structured blocker", () => {
    const noFindings = ReviewResultSchema.safeParse({
      repo: "o/r", pr: 1, event: "request-changes", summary: "please change this", reviewedSha: "sha0001",
    });
    const speculative = ReviewResultSchema.safeParse({
      repo: "o/r", pr: 1, event: "request-changes", summary: "might fail", reviewedSha: "sha0001",
      findings: [finding({ confidence: "plausible" })],
    });
    expect(noFindings.success).toBe(false);
    expect(speculative.success).toBe(false);
  });
});
