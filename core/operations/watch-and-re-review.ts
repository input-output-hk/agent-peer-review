import type { GitHubGateway } from "../github.js";
import { humanReviewStatus } from "../expedition/human-review.js";
import { buildReviewHistory } from "../review-record.js";
import { sortReviews, standingVerdicts, STANDING_VERDICT_STATES } from "../expedition/protection.js";

export interface WatchAndReReviewInput {
  repo: string;
  pr: number;
  /** The acting agent's login: whose review history this operation is following. */
  myLogin: string;
  /** How many reviews this agent may write on one pull request before handing it to a human. */
  maxReviewRounds?: number;
  knownAgentLogins?: string[];
}

export interface WatchAndReReviewResult {
  action: "re-review" | "wait" | "hold-for-human" | "abandoned" | "approved" | "none";
  reason: string;
  /**
   * Whether this agent's standing verdict was left on a commit that is no longer the head.
   *
   * Reported as data, not only inside `reason`, so a flow can branch on it without reading prose
   * (issue #53). It matters most on `approved`, where it says the approval is stale: nobody has
   * approved the code that would merge now, which is exactly what gate rail 5 refuses to count. What
   * to do about that is the flow's call, since only it knows the repository's policy, and today no
   * flow does anything with it; the follow-up is a re-affirmation round.
   *
   * False whenever there is no standing verdict of this agent's for the head to have moved past.
   */
  headMoved: boolean;
}

export const DEFAULT_MAX_REVIEW_ROUNDS = 3;

/**
 * Decide what to do next about a pull request this agent has already reviewed.
 *
 * Pure decision, no mutation whatsoever: it reads state and returns a verb. The caller (a flow)
 * runs the existing claim/complete lifecycle when the answer is "re-review".
 *
 * The round cap is what keeps an agent and an author from ping-ponging forever. It is checked
 * before the human-review test so that an agent that has already used its rounds hands over for
 * that reason, whether or not a human happens to be looking right now.
 *
 * A round is a VERDICT, not a review. Counting every review by this login spent the cap on writes
 * that asked the author for nothing (issue #52): a second opinion is a COMMENTED review, and so is
 * a primary that `completeReview` downgraded because a competing one already existed, so two of
 * those plus one real verdict exhausted a cap meant for three rounds of back-and-forth. The count
 * only ever grows, which made `hold-for-human` permanent for that pull request no matter what the
 * human then did.
 *
 * Two boundaries worth stating, because both look like omissions:
 *
 * - An approval is reported as "approved" even after the author has pushed past the commit it was
 *   given at. Re-affirming a stale approval is explicitly a later phase, so deciding what to do
 *   about one belongs to the flow layer, which knows the repository's policy; this operation makes
 *   sure the answer is honest about it, in the reason and in `headMoved`, so the flow is never
 *   surprised by it. The merge side no longer takes such an approval on trust either: gate rail 5
 *   does not count an approval of a commit that is not the head (issue #53).
 * - An agent whose login the caller did not pass in `knownAgentLogins` reads as a human and holds
 *   the pull request. That is the deliberate conservative direction (see human-review.ts); PR 4
 *   supplies the configured agent logins.
 *
 * "A human is involved" is the same question the safety gate's rail 7 asks, and it is answered from
 * the same place (humanReviewStatus), so the two cannot drift: a human who was asked and has not
 * answered holds the pull request, and so does a human's standing CHANGES_REQUESTED. A human's
 * finished APPROVED or a comment-only review does not, because neither is somebody mid-review and
 * neither is a refusal, and treating them as one froze this operation permanently on any pull request
 * a human had ever touched (issue #57).
 */
export async function watchAndReReview(gh: GitHubGateway, input: WatchAndReReviewInput): Promise<WatchAndReReviewResult> {
  const { repo, pr, myLogin } = input;
  // This operation is part of the published core API, so the safety boundary must live here as
  // well as in the pi adapter's TypeBox schema. A JavaScript caller can bypass that schema (or pass
  // NaN/Infinity despite the TypeScript type); none of those values may disable the built-in human
  // handoff. Valid smaller values still tighten the cap.
  const requestedMaxRounds = input.maxReviewRounds;
  const maxRounds = requestedMaxRounds === undefined || !Number.isFinite(requestedMaxRounds)
    ? DEFAULT_MAX_REVIEW_ROUNDS
    : Math.min(Math.max(Math.trunc(requestedMaxRounds), 1), DEFAULT_MAX_REVIEW_ROUNDS);

  const pull = await gh.getPullRequest(repo, pr);
  if (pull.state !== "open") {
    return { action: "abandoned", reason: `the pull request is ${pull.state}; there is nothing left to review`, headMoved: false };
  }

  const reviews = await gh.getReviews(repo, pr);
  // Sorted by submission time rather than trusted to arrive in order: which of this agent's reviews
  // is the standing one decides whether the pull request gets touched again.
  const normalizedLogin = myLogin.toLowerCase();
  const mine = sortReviews(reviews).filter((r) => r.author.toLowerCase() === normalizedLogin);
  if (mine.length === 0) return { action: "none", reason: "this agent has not reviewed this pull request", headMoved: false };

  // Every verdict this agent has left, oldest first. The shared standing-verdict map decides which
  // one is live; the list exists only to count how many review rounds have been spent. In particular,
  // DISMISSED must never fall through as "comments but no verdict": it is GitHub's record that a
  // maintainer retired a verdict, including automatically after a push on branches that dismiss stale
  // reviews.
  const verdicts = mine.filter((r) => STANDING_VERDICT_STATES.has(r.state));
  const history = buildReviewHistory(reviews, pull.headSha);
  const latest = standingVerdicts(reviews).get(normalizedLogin);
  if (!latest) {
    return { action: "none", reason: "this agent has left comments but no verdict on this pull request", headMoved: false };
  }
  // One answer for every branch below, so the flag and the prose can never say different things.
  const headMoved = pull.headSha !== latest.commitId;
  if (latest.state === "DISMISSED") {
    return {
      action: "hold-for-human",
      reason: "this agent's standing verdict was dismissed; only a human should decide whether to replace it",
      headMoved,
    };
  }
  if (latest.state === "APPROVED") {
    return headMoved
      ? {
        action: "approved",
        reason: `this agent approved at ${latest.commitId}; the head has since moved to ${pull.headSha}, and re-affirmation is a later phase`,
        headMoved,
      }
      : { action: "approved", reason: `this agent approved at ${latest.commitId}`, headMoved };
  }

  if (!headMoved) {
    return { action: "wait", reason: `no push since this agent requested changes at ${latest.commitId}`, headMoved };
  }

  if (verdicts.length >= maxRounds) {
    return {
      action: "hold-for-human",
      reason: `review round cap reached (${verdicts.length} of ${maxRounds}); handing this pull request to a human`,
      headMoved,
    };
  }

  // An outstanding team request counts as a pending human review: its members cannot be enumerated
  // from here, and a team is a group of people until proven otherwise.
  const requested = await gh.listRequestedReviewers(repo, pr);
  const human = humanReviewStatus({
    reviews, requestedUsers: requested.users, actingLogin: myLogin, knownAgentLogins: input.knownAgentLogins,
  });
  if (requested.teams.length > 0 || human.pendingRequest) {
    return { action: "hold-for-human", reason: "a human review is in flight; this agent will not race it", headMoved };
  }
  if (human.changesRequested) {
    return {
      action: "hold-for-human",
      reason: "a human has requested changes; this agent will not review over that standing verdict",
      headMoved,
    };
  }

  return {
    action: "re-review",
    reason: history.mode === "convergence"
      ? `the head moved from ${latest.commitId} to ${pull.headSha} after ${history.changesRequestedCycles} changes-requested cycles; re-review in convergence mode`
      : `the head moved from ${latest.commitId} to ${pull.headSha} after this agent requested changes; re-review in rereview mode`,
    headMoved,
  };
}
