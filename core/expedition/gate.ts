import type { ChangeClassification } from "./classify.js";

// The one central safety gate for taskflow auto-merge decisions (ADR 0009). Every input needed to
// decide "auto" vs "propose" is threaded through explicitly as plain data. This module does no
// I/O, reads no clock, and calls no gateway; callers compute each field from real GitHub/config
// state and act on the decision. autonomy defaults to "propose" everywhere: the "auto" branch is
// reachable only when a caller explicitly passes autonomy "auto" on a single call (today: the pi
// pr_expedite / pr_approve_dep_upgrade tools). No config or env path can produce it.
//
// Conservative by default: `evaluateGates` returns "auto" only when EVERY rail passes. A rail that
// cannot be proven safe, including one added later but not wired into this function, simply never
// reports a pass, which fails safe: the change proposes instead of merging.

export type GateAction = "auto" | "propose";

export interface GateInput {
  classification: ChangeClassification;
  changedFiles: number;
  changedLines: number;
  checks: "green" | "pending" | "failing"; // required checks rollup
  mergeableState: "clean" | "dirty" | "behind" | "blocked" | "unstable" | "unknown";
  branchProtectionSatisfied: boolean; // required reviews/checks/conversations/enforce_admins all met (computed elsewhere)
  hasNewSecurityAlert: boolean;
  humanReviewInFlight: boolean;
  autonomy: "auto" | "propose"; // per-repo/per-class setting; v1 default propose
  headShaGuardPassed: boolean; // the SHA we evaluated still equals the head we would act on
  actingLogin: string;
  author: string;
  isApproving: boolean;
  policy?: { maxFiles?: number; maxLines?: number };
}

export interface GateDecision {
  action: GateAction;
  reasons: string[];
}

export const DEFAULT_GATE_POLICY = { maxFiles: 10, maxLines: 200 } as const;

// Fails closed: a count only passes when it is a non-negative integer within its cap. A bare
// `n > cap` comparison would fail OPEN on a negative or non-numeric count (e.g. -5 > 10 is false),
// silently letting a malformed value through the rail. Returns a reason string on failure, either
// because the count itself is not sensible, or because it exceeds the cap; null when it passes.
function sizeCapFailure(n: number, cap: number, label: string): string | null {
  if (!Number.isInteger(n) || n < 0) return `changed ${label} count is invalid (${n}); expected a non-negative integer`;
  return n > cap ? `too many changed ${label} (${n} > ${cap})` : null;
}

/**
 * Evaluate all ten safety rails and decide "auto" vs "propose".
 *
 * Never throws: every check below is a plain comparison over the given data, with no I/O, no
 * Date.now, and no randomness. Returns "auto" iff zero rails fail; otherwise "propose" with one
 * human-readable reason string per failed rail, so a proposal comment can explain itself.
 */
export function evaluateGates(input: GateInput): GateDecision {
  const reasons: string[] = [];
  const maxFiles = input.policy?.maxFiles ?? DEFAULT_GATE_POLICY.maxFiles;
  const maxLines = input.policy?.maxLines ?? DEFAULT_GATE_POLICY.maxLines;

  // 1. Classification: only the closed docs/lint/ci/deps allowlist is auto-eligible; any source or
  // test path disqualifies the whole change.
  if (!input.classification.autoEligible) {
    const offending = input.classification.byFile.filter((f) => f.category === "source" || f.category === "test");
    reasons.push(
      offending.length > 0
        ? `not auto-eligible: ${[...new Set(offending.map((f) => f.category))].join("/")} path(s) present (${offending.map((f) => f.file).join(", ")})`
        : "not auto-eligible: no changed files",
    );
  }

  // 2. Size caps. Both dimensions are folded into a single reason so this stays one rail.
  const sizeFails: string[] = [];
  const filesFailure = sizeCapFailure(input.changedFiles, maxFiles, "files");
  if (filesFailure) sizeFails.push(filesFailure);
  const linesFailure = sizeCapFailure(input.changedLines, maxLines, "lines");
  if (linesFailure) sizeFails.push(linesFailure);
  if (sizeFails.length > 0) reasons.push(sizeFails.join("; "));

  // 3. Required checks must be green; pending or failing both fail. Never merge on red or unknown.
  if (input.checks !== "green") reasons.push(`required checks are ${input.checks} (need green)`);

  // 4. GitHub's own mergeable state must be clean.
  if (input.mergeableState !== "clean") reasons.push(`mergeable state is ${input.mergeableState} (need clean)`);

  // 5. Branch protection (required reviews/checks/conversations/enforce_admins) must be satisfied.
  if (!input.branchProtectionSatisfied) reasons.push("branch protection requirements are not satisfied");

  // 6. The security alert rail must be satisfied. The wording stays neutral because the input is
  // whatever the caller could actually establish, which today is a repository-wide open-alert count
  // that may also be unreadable; claiming "new on this change" would overstate it. Callers append
  // the specific cause (alerts present, or no access) as an extra reason.
  if (input.hasNewSecurityAlert) reasons.push("the security alert rail is not satisfied");

  // 7. No human review in flight; never race a human reviewer.
  if (input.humanReviewInFlight) reasons.push("a human review is in flight");

  // 8. The per-repo/per-class autonomy setting must itself be "auto". This alone forces propose.
  if (input.autonomy !== "auto") reasons.push(`autonomy is "${input.autonomy}", not "auto"`);

  // 9. Head SHA guard: the SHA evaluated must still equal the head we would act on.
  if (!input.headShaGuardPassed) reasons.push("head SHA guard failed: the head moved since this evaluation");

  // 10. GitHub forbids self-approval. Only relevant when this decision is itself an approval; a
  // non-approving action passes regardless of who is acting.
  if (input.isApproving && input.actingLogin === input.author) {
    reasons.push(`self-approval is not allowed: "${input.actingLogin}" is both acting and the PR author`);
  }

  return { action: reasons.length === 0 ? "auto" : "propose", reasons };
}
