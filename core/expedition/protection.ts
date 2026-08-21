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
  /**
   * True when the caller is an operation that is ABOUT to submit an approving review of its own, and
   * that approval is not already counted in `approvalsByOthers` (see gatherRails, which is the only
   * place that computes this: the acting login differs from the author and holds no standing
   * approval). Then, and only then, the required-approvals comparison counts it.
   *
   * Why this is sound rather than a bypass:
   *
   * - The approval is a real action, not an assumption. `approveDependencyUpgrade` submits it, and
   *   GitHub counts it toward the same requirement this function is evaluating. Judging the pull
   *   request without it would be judging a state that will not exist by the time anything merges.
   * - Without it the operation that SUPPLIES the approval can never satisfy the requirement its own
   *   approval exists to satisfy: `approvalsByOthers` is read before the approval is posted, so on
   *   any repository requiring an approving review the comparison is unsatisfiable and the auto path
   *   is unreachable on exactly the repositories that need it (issue #48).
   * - It adds exactly one, so every requirement above one still holds: two required approvals with
   *   none present stays false (0 + 1 < 2), and a human's approval is still required to reach it.
   * - It relaxes nothing else. `"unknown"` protection, required conversation resolution, red or
   *   pending required checks, and a malformed count all still fail closed, and the malformed-count
   *   guards below run BEFORE the increment so a bogus count cannot be rescued by it.
   * - The approval is separately gated. Rail 10 refuses self-approval, and gatherRails withholds
   *   this flag when the acting login is the author, so it can never stand in for an approval GitHub
   *   would not accept.
   *
   * Callers that do not approve (`expedite`) never set it, and the comparison is then exactly what
   * it always was.
   */
  pendingApprovalFromActor?: boolean;
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
 * "Required approvals must be met" counts the approval the caller is about to submit, when the
 * caller told us it is about to submit one; see ProtectionState.pendingApprovalFromActor for why
 * that is sound and for everything it deliberately does not relax.
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
    // Both guards above ran on the RAW count, so the pending approval cannot rescue a malformed one:
    // NaN + 1 is still NaN, and this line is only reached once the count is a non-negative integer.
    const approvals = state.approvalsByOthers + (state.pendingApprovalFromActor === true ? 1 : 0);
    if (approvals < needed) return false;
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
 * The standing verdict per login: the state of each login's LATEST verdict-bearing review.
 *
 * One implementation, because both questions asked below ("how many others approve" and "does this
 * one login approve") have to be answered the same way or the pending-approval increment would
 * double-count an approval already in the total.
 *
 * Keyed by the LOWERCASED login, and every comparison against it lowercases too. GitHub logins are
 * unique case-insensitively, so two rows differing only in case are one account, and an exact
 * comparison here would fail OPEN in the one place it matters: `hasStandingApproval("Me")` would
 * report "no approval yet" for an approval `countApprovalsByOthers` is already counting, and the
 * single approval would be counted twice. It also means the pull request author's own approval is
 * excluded whatever case the API reported it in, which is the conservative direction.
 */
function standingVerdicts(reviews: Review[]): Map<string, string> {
  const latestVerdict = new Map<string, string>();
  for (const r of sortReviews(reviews)) {
    if (!VERDICT_STATES.has(r.state)) continue;
    latestVerdict.set(r.author.toLowerCase(), r.state);
  }
  return latestVerdict;
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
  const excluded = author.toLowerCase();
  let count = 0;
  for (const [login, state] of standingVerdicts(reviews)) {
    if (login === excluded) continue;
    if (state === "APPROVED") count++;
  }
  return count;
}

/**
 * Whether `login`'s standing verdict is an approval: the same question countApprovalsByOthers asks
 * of every other login, asked about one.
 *
 * This is how a would-be approver finds out whether its approval is already counted in
 * `approvalsByOthers`, so it exists to keep ProtectionState.pendingApprovalFromActor from adding an
 * approval that is already in the total. Deliberately NOT filtered by commit SHA: protection counts
 * standing approvals whatever commit they were left on, countApprovalsByOthers does not filter
 * either, and filtering here would report "no approval yet" for one that protection is already
 * counting, which is precisely the double count this answers. Logins are compared
 * case-insensitively for the same reason; see standingVerdicts.
 */
export function hasStandingApproval(reviews: Review[], login: string): boolean {
  return standingVerdicts(reviews).get(login.toLowerCase()) === "APPROVED";
}
