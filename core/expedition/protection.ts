// Branch protection evaluation: turns a BranchProtectionSummary plus the pull request's current
// approval/check state into the single boolean the safety gate takes (see gate.ts, rail 5). Pure:
// no I/O, no clock, no randomness.
//
// Conservative by default: every path that cannot be positively proven satisfied returns false.

import type { BranchProtectionSummary } from "../github.js";
import type { Review } from "../model.js";
import type { ChecksSummary } from "./checks.js";

export interface ProtectionState {
  /**
   * Approving reviews by logins other than the PR author that count for the commit being evaluated.
   *
   * "That count" is load-bearing: an approval of a commit the author has since pushed past is not an
   * approval of the code that would merge (issue #53). The filtering happens in
   * countApprovalsByOthers, which is given the head commit and the branch's `dismiss_stale_reviews`
   * setting, so this number is already the countable one by the time it arrives here.
   */
  approvalsByOthers: number;
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
 * that is sound and for everything it deliberately does not relax. It counts only approvals that are
 * about the commit being evaluated; see countApprovalsByOthers and ApprovalScope.
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
export const STANDING_VERDICT_STATES: ReadonlySet<string> = new Set([
  "APPROVED",
  "CHANGES_REQUESTED",
  "DISMISSED",
]);

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

/** One login's latest verdict-bearing review: the position that login currently holds. */
export interface StandingVerdict {
  /** The login exactly as the API reported it on that review, for callers that compare logins. */
  login: string;
  /** One of STANDING_VERDICT_STATES. */
  state: string;
  /** The commit the verdict was left on; "" when the API reported none. */
  commitId: string;
}

/**
 * The standing verdict per login: each login's LATEST verdict-bearing review.
 *
 * One implementation, and the only definition of "standing" in this package. Every question about a
 * standing position is answered from it, here and in human-review.ts, because a second notion of
 * "standing" is a second thing to keep in step: the pending-approval increment would double-count an
 * approval already in the total, or rail 7 would call a verdict standing that rail 5 had already
 * treated as replaced.
 *
 * Keyed by the LOWERCASED login, and every comparison against the KEY lowercases too. GitHub logins
 * are unique case-insensitively, so two rows differing only in case are one account, and an exact
 * comparison on the key would fail OPEN in the one place it matters: `hasStandingApproval("Me")`
 * would report "no approval yet" for an approval `countApprovalsByOthers` is already counting, and
 * the single approval would be counted twice. It also means the pull request author's own approval is
 * excluded whatever case the API reported it in, which is the conservative direction.
 */
export function standingVerdicts(reviews: Review[]): Map<string, StandingVerdict> {
  const latestVerdict = new Map<string, StandingVerdict>();
  for (const r of sortReviews(reviews)) {
    if (!STANDING_VERDICT_STATES.has(r.state)) continue;
    latestVerdict.set(r.author.toLowerCase(), { login: r.author, state: r.state, commitId: r.commitId });
  }
  return latestVerdict;
}

/**
 * What an approval has to be about before a required-approvals rule may count it.
 *
 * Issue #53: a peer approved `sha0001`, the author pushed `sha0009`, and the gate merged `sha0009` on
 * the strength of the approval of `sha0001`. Nobody had approved the code that merged. "Would GitHub
 * count this approval" and "did anyone approve THIS code" are different questions, and rail 5 is only
 * safe to answer with the second one.
 *
 * `dismissesStaleReviews` is the one case where the commit does not have to be checked here, because
 * GitHub has already checked it: on such a branch a push retires the approving reviews, so an
 * approval that is still standing is an approval of the current code by construction. Reading the
 * flag rather than always filtering is what keeps this from being stricter than the repository is:
 * where GitHub itself dismisses on push, an approval left on a commit our snapshot has not caught up
 * with is still a real approval of what is now the head.
 */
export interface ApprovalScope {
  /** The head commit being evaluated: the commit an action would actually merge. */
  headSha: string;
  /** The base branch's `dismiss_stale_reviews`. False for unreadable or absent protection. */
  dismissesStaleReviews: boolean;
}

/**
 * Whether one standing verdict is an approval that `scope` allows to be counted.
 *
 * SHAs are compared exactly. GitHub reports both sides as lowercase hex, and a mismatch of any kind
 * fails toward "does not count", which is the conservative direction.
 */
function countableApproval(verdict: StandingVerdict, scope: ApprovalScope): boolean {
  if (verdict.state !== "APPROVED") return false;
  return scope.dismissesStaleReviews || verdict.commitId === scope.headSha;
}

/**
 * Count the distinct logins, other than `author`, whose LATEST verdict review is an approval that
 * counts for `scope`. This is the `approvalsByOthers` input to protectionSatisfied, and it lives here
 * so the two stay in step.
 *
 * The last verdict per author wins, so a later CHANGES_REQUESTED or a DISMISSED review correctly
 * cancels an earlier approval. The PR author's own approval is never counted: GitHub does not
 * accept it toward a required-approvals rule. An approval of a commit that is no longer the head is
 * not counted either, unless the branch dismisses stale reviews itself; see ApprovalScope.
 */
export function countApprovalsByOthers(reviews: Review[], author: string, scope: ApprovalScope): number {
  const excluded = author.toLowerCase();
  let count = 0;
  for (const [login, verdict] of standingVerdicts(reviews)) {
    if (login === excluded) continue;
    if (countableApproval(verdict, scope)) count++;
  }
  return count;
}

/**
 * Whether `login` holds an approval that counts for `scope`: the same question countApprovalsByOthers
 * asks of every other login, asked about one.
 *
 * This is how a would-be approver finds out whether its approval is already counted in
 * `approvalsByOthers`, so it exists to keep ProtectionState.pendingApprovalFromActor from adding an
 * approval that is already in the total. It therefore has to apply the SAME scope the count applies:
 * an approval the count is ignoring as stale must be reported as absent here, or the operation whose
 * job is to approve the new head would withhold its own pending approval on the grounds of an
 * approval nothing is counting, and rail 5 would be unsatisfiable at every head after the first. The
 * question "should a fresh approval be POSTED at this head" is a different one, and its caller
 * answers it separately.
 *
 * Logins are compared case-insensitively, for the reason given on standingVerdicts.
 */
export function hasStandingApproval(reviews: Review[], login: string, scope: ApprovalScope): boolean {
  const verdict = standingVerdicts(reviews).get(login.toLowerCase());
  return verdict !== undefined && countableApproval(verdict, scope);
}
