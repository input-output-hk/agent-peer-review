// Internals shared by the expedition operations that consult the safety gate (expedite,
// approveDependencyUpgrade): the gathering step that reads every rail input, and the propose-mode
// comment mechanics that keep a proposal idempotent across ticks. Neither is an operation and
// neither is part of the package's public surface.
//
// They live in one place on purpose. Two copies of "read the checks, read protection, count
// approvals, guard the head SHA" would be two things to keep in step, and a rail that silently
// drifts in one of them is exactly the failure this gate exists to prevent.

import type { GitHubGateway, Mergeability, DetailedPullFile } from "../github.js";
import type { Review } from "../model.js";
import { summarizeChecks, type ChecksSummary } from "../expedition/checks.js";
import { protectionSatisfied, countApprovalsByOthers, hasStandingApproval } from "../expedition/protection.js";
import { humanReviewInFlight } from "../expedition/human-review.js";
import { findActionMarkers, type ActionMarker } from "../expedition/action-marker.js";
import { renderProposal } from "../expedition/proposal.js";

export interface RailInputs {
  changedFiles: number;
  changedLines: number;
  checksSummary: ChecksSummary;
  approvalsByOthers: number;
  /** Every review on the pull request, in GitHub's chronological order. Already fetched for the rails above. */
  reviews: Review[];
  /**
   * Whether `willApproveAs`'s standing verdict is already an approval, so a caller can reuse the
   * answer instead of recomputing it. `false` when no `willApproveAs` was given: the question was
   * never asked, because only an operation that intends to approve has an approver to ask about.
   */
  actorHasStandingApproval: boolean;
  branchProtectionSatisfied: boolean;
  hasNewSecurityAlert: boolean;
  /** The specific cause behind `hasNewSecurityAlert`, so a caller can say which one it is. Null when the rail passes. */
  securityDetail: string | null;
  humanReviewInFlight: boolean;
  headShaGuardPassed: boolean;
}

// -- Acting identity -----------------------------------------------------------------------

/**
 * Resolve the login this operation is acting as, and refuse to act under a borrowed name.
 *
 * The acting login is load-bearing rather than cosmetic: it selects which comments count as "my own
 * proposals" for idempotency, and it is one side of the gate's self-approval rail. A caller that
 * passes a login the token does not actually own silently loses both, and the visible symptom is a
 * duplicate proposal posted on every tick.
 *
 * So an omitted login is resolved from the token (matching how claimReview resolves its reviewer),
 * and a supplied one must match it. A mismatch THROWS rather than returning a status: it is a
 * misconfiguration in the caller, not an outcome of evaluating the pull request, and the operations'
 * "never throw for a policy outcome" rule is exactly about the latter.
 */
export async function resolveActingLogin(gh: GitHubGateway, provided?: string): Promise<string> {
  const authenticated = await gh.getAuthenticatedLogin();
  if (provided !== undefined && provided !== authenticated) {
    throw new Error(`actingLogin "${provided}" is not the authenticated login "${authenticated}"; refusing to act under another login`);
  }
  return authenticated;
}

// -- Rail gathering ------------------------------------------------------------------------

export async function gatherRails(
  gh: GitHubGateway,
  input: {
    repo: string;
    pr: number;
    /** H: the head SHA every read below is evaluated against, taken from the caller's first getPullRequest. */
    headSha: string;
    author: string;
    actingLogin: string;
    /** Read by the caller in this same tick; its baseRef is what protection is read for. */
    mergeability: Mergeability;
    files: DetailedPullFile[];
    knownAgentLogins?: string[];
    /**
     * The login this call is about to submit an approving review as, passed ONLY by an operation
     * that really does approve (today: approveDependencyUpgrade). It changes exactly one thing: the
     * required-approvals comparison inside protectionSatisfied counts that approval, because it is
     * an action about to be taken rather than a hypothetical. Omit it and every rail below is
     * computed exactly as it always was.
     */
    willApproveAs?: string;
  },
): Promise<RailInputs> {
  const { repo, pr, headSha, mergeability, files } = input;

  const [checks, protection, reviews, requestedReviewers, alertCount] = await Promise.all([
    gh.getChecks(repo, headSha),
    // The base branch comes from the mergeability response read in this same tick, never from a
    // guessed or remembered branch name. getBranchProtection reports "none" on any 404, and GitHub
    // 404s a branch that does not exist as readily as one with no protection, so asking about the
    // wrong branch would look exactly like asking about an unprotected one.
    gh.getBranchProtection(repo, mergeability.baseRef),
    gh.getReviews(repo, pr),
    gh.listRequestedReviewers(repo, pr),
    gh.listOpenSecurityAlertCount(repo),
  ]);

  const requiredChecks = typeof protection === "object" ? protection.requiredChecks : undefined;
  const checksSummary = summarizeChecks(checks, requiredChecks);
  const approvalsByOthers = countApprovalsByOthers(reviews, input.author);

  // Whether the approval this caller is about to add counts toward the required-approvals rule.
  // Three conditions, all necessary:
  //
  //   willApproveAs given      - only an operation that really submits an approval may claim one.
  //   not the pull's author    - GitHub refuses a self-approval, so it would never be counted
  //                              (rail 10 refuses the whole action too).
  //   no standing approval     - one already there is already inside approvalsByOthers; adding it
  //                              again would count a single approval twice.
  //
  // The standing check is deliberately not filtered by commit SHA: protection counts a standing
  // approval whatever commit it was left on, and countApprovalsByOthers does not filter either, so
  // filtering here is what would produce the double count. Whether to POST a fresh approval at this
  // head is a different question, and its caller answers it separately.
  const actorHasStandingApproval = input.willApproveAs !== undefined && hasStandingApproval(reviews, input.willApproveAs);
  const pendingApprovalFromActor = input.willApproveAs !== undefined
    && input.willApproveAs !== input.author
    && !actorHasStandingApproval;

  // null means the alert API could not be read at all (disabled, or no access). "We do not know"
  // is never "safe", so it fails the rail exactly like a real alert would, with a different reason
  // so the proposal comment can say which of the two happened.
  //
  // Note the scope: listOpenSecurityAlertCount counts OPEN alerts across the repository, not alerts
  // introduced by this change. A repository carrying any unresolved alert therefore never clears
  // this rail. That is deliberate for v1.
  const securityDetail = alertCount === null
    ? "security alert status unknown (no access to the alerts API): failing closed"
    : alertCount > 0
      ? `${alertCount} open security alert(s) on this repository`
      : null;

  // Last read in the gather, on purpose: it closes the window opened by every read above. If the
  // head moved while the rails were being collected, they describe a commit that is no longer the
  // one an action would apply to, and the gate must refuse.
  const fresh = await gh.getPullRequest(repo, pr);

  return {
    changedFiles: files.length,
    changedLines: files.reduce((sum, f) => sum + f.additions + f.deletions, 0),
    checksSummary,
    approvalsByOthers,
    reviews,
    actorHasStandingApproval,
    branchProtectionSatisfied: protectionSatisfied(protection, { approvalsByOthers, checksSummary, pendingApprovalFromActor }),
    hasNewSecurityAlert: securityDetail !== null,
    securityDetail,
    // A requested TEAM is a human review in flight too. Its members cannot be enumerated from here
    // without another API call, and a team is a group of people until proven otherwise, so any
    // outstanding team request counts. humanReviewInFlight itself only judges individual logins.
    humanReviewInFlight: requestedReviewers.teams.length > 0 || humanReviewInFlight({
      reviews,
      requestedUsers: requestedReviewers.users,
      actingLogin: input.actingLogin,
      knownAgentLogins: input.knownAgentLogins,
    }),
    headShaGuardPassed: fresh.headSha === headSha,
  };
}

// -- Propose-mode comment mechanics --------------------------------------------------------

/**
 * Post (or recognize) this agent's proposal comment for one head SHA.
 *
 * Idempotent across ticks, and it looks at THIS agent's own comments only: a marker in someone
 * else's comment says nothing about what this agent has already posted, and a proposal by another
 * actor must not silence this one.
 *
 * - A proposal of the same kind already at `headSha`: nothing is posted, and the caller reports
 *   "already-proposed". Re-running every tick must not fill the thread with duplicates.
 * - Proposals of the same kind at older heads: deleted before the new one goes up, so the thread
 *   carries exactly one live proposal describing the commit that is actually current.
 *
 * Deletes come first so a failure between the two leaves no stale proposal claiming to describe
 * the head; the next tick simply posts the fresh one.
 *
 * Known staleness: the marker keys on the head SHA alone, so a proposal keeps the rationale written
 * on the first tick even if the reasons change while the head does not (a check goes from pending
 * to failing, say). The comment stays truthful about WHAT is proposed and at which commit, only its
 * list of blockers can age. Rewriting on every reason change would mean editing or re-posting the
 * comment on ordinary CI churn, which is worse for the reader; folding a digest of the reasons into
 * the marker and re-posting only when that digest changes is the refinement if this ever matters.
 */
export async function postProposal(
  gh: GitHubGateway,
  input: {
    repo: string;
    pr: number;
    actingLogin: string;
    kind: ActionMarker["kind"];
    headSha: string;
    now: string;
    action: string;
    changeClasses: string[];
    reasons: string[];
    details?: string[];
  },
): Promise<"proposed" | "already-proposed"> {
  const { repo, pr, headSha } = input;
  const own = (await gh.listComments(repo, pr)).filter((c) => c.author === input.actingLogin);
  const mine = findActionMarkers(own).filter((m) => m.marker.kind === input.kind);
  if (mine.some((m) => m.marker.headSha === headSha)) return "already-proposed";

  for (const stale of mine) await gh.deleteComment(repo, stale.comment.id);
  const marker: ActionMarker = { v: 1, kind: input.kind, headSha, decision: "propose", at: input.now };
  await gh.createComment(repo, pr, renderProposal({
    action: input.action,
    changeClasses: input.changeClasses,
    reasons: input.reasons,
    details: input.details,
    headSha,
    marker,
  }));
  return "proposed";
}
