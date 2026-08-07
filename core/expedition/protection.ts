// Branch protection evaluation: turns a BranchProtectionSummary plus the pull request's current
// approval/check state into the single boolean the safety gate takes (see gate.ts, rail 5). Pure:
// no I/O, no clock, no randomness.
//
// Conservative by default: every path that cannot be positively proven satisfied returns false.

import type { BranchProtectionSummary } from "../github.js";
import type { Review } from "../model.js";
import type { ChecksSummary } from "./checks.js";

export interface ProtectionState {
  approvalsByOthers: number;      // approving reviews by logins other than the PR author
  checksSummary: ChecksSummary;   // the same rollup fed to gate rail 3 (see summarizeChecks)
}

/**
 * True when the base branch's protection requirements are met.
 *
 * - `"none"`: no protection is configured, so there is nothing to satisfy. This is only
 *   trustworthy for a branch the caller read from the SAME `getMergeability`/`getPullRequest`
 *   response it is acting on: `getBranchProtection` reports "none" on any 404, and GitHub also
 *   404s a branch that does not exist, so a guessed or stale branch name would read as
 *   "unprotected" when it is really "not a branch".
 * - `"unknown"`: the token could not read protection (403). "Protected but invisible to me" and
 *   "unprotected" are indistinguishable from here, so this fails closed.
 * - A summary object: required checks must be green, required approvals must be met, and required
 *   conversation resolution is an automatic false.
 *
 * `requiresConversationResolution` fails closed because whether every review thread is resolved
 * cannot be answered cheaply over REST (it needs a GraphQL query per thread). Rather than guess,
 * a repository that requires conversation resolution always proposes instead of merging.
 *
 * `enforceAdmins` is deliberately not consulted: it changes who may bypass these requirements, not
 * what the requirements are, and this function already assumes no bypass.
 */
export function protectionSatisfied(
  protection: BranchProtectionSummary | "none" | "unknown",
  state: ProtectionState,
): boolean {
  if (protection === "none") return true;
  if (protection === "unknown") return false;
  if (protection.requiresConversationResolution) return false;
  if (protection.requiredChecks.length > 0 && state.checksSummary !== "green") return false;
  if (protection.requiresPullRequestReviews) {
    const needed = protection.requiredApprovingReviewCount;
    // Fail closed on a nonsensical count on either side rather than let a malformed number
    // satisfy the comparison by accident (e.g. NaN >= 1 is false, but NaN >= 0 is false too, so
    // the check below would wrongly reject; an explicit guard makes the intent unambiguous).
    if (!Number.isInteger(state.approvalsByOthers) || state.approvalsByOthers < 0) return false;
    if (!Number.isInteger(needed) || needed < 0) return false;
    if (state.approvalsByOthers < needed) return false;
  }
  return true;
}

// States that carry a verdict. GitHub replaces a user's standing verdict only with another
// verdict: a COMMENTED (or PENDING) review left after an approval does not withdraw it.
const VERDICT_STATES: ReadonlySet<string> = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

/**
 * Order reviews oldest to newest by submission time, with the review id as the tie-break.
 *
 * "Which verdict is the standing one" is a safety-relevant question, so it is answered from the
 * data rather than from the order the list happened to arrive in. Mirrors sortMarkers in
 * claim-marker.ts. `submittedAt` is an ISO timestamp, so a lexicographic compare is chronological;
 * a pending review has an empty one and sorts first, which is correct (it was never submitted).
 */
export function sortReviews(reviews: Review[]): Review[] {
  return [...reviews].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.id - b.id);
}

/**
 * Count the distinct logins, other than `author`, whose LATEST verdict review is an approval.
 * This is the `approvalsByOthers` input to protectionSatisfied, and it lives here so the two stay
 * in step.
 *
 * The last verdict per author wins, so a later CHANGES_REQUESTED or a DISMISSED review correctly
 * cancels an earlier approval. The PR author's own approval is never counted: GitHub does not
 * accept it toward a required-approvals rule.
 */
export function countApprovalsByOthers(reviews: Review[], author: string): number {
  const latestVerdict = new Map<string, string>();
  for (const r of sortReviews(reviews)) {
    if (r.author === author) continue;
    if (!VERDICT_STATES.has(r.state)) continue;
    latestVerdict.set(r.author, r.state);
  }
  let count = 0;
  for (const state of latestVerdict.values()) if (state === "APPROVED") count++;
  return count;
}
