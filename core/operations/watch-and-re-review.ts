import type { GitHubGateway } from "../github.js";
import type { Review } from "../model.js";
import { humanReviewInFlight } from "../expedition/human-review.js";
import { sortReviews } from "../expedition/protection.js";

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
}

export const DEFAULT_MAX_REVIEW_ROUNDS = 3;

// States that carry a verdict. A COMMENTED review is a note or a second opinion, not a position on
// the change, so it never becomes the review this operation follows up on.
const VERDICT_STATES: ReadonlySet<string> = new Set(["APPROVED", "CHANGES_REQUESTED"]);

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
 * Two boundaries worth stating, because both look like omissions:
 *
 * - An approval is reported as "approved" even after the author has pushed past the commit it was
 *   given at. Re-affirming a stale approval is explicitly a later phase, so deciding what to do
 *   about one belongs to the flow layer, which knows the repository's policy; this operation only
 *   makes sure the reason says the head has moved, so the flow is never surprised by it.
 * - An agent whose login the caller did not pass in `knownAgentLogins` reads as a human and holds
 *   the pull request. That is the deliberate conservative direction (see human-review.ts); PR 4
 *   supplies the configured agent logins.
 */
export async function watchAndReReview(gh: GitHubGateway, input: WatchAndReReviewInput): Promise<WatchAndReReviewResult> {
  const { repo, pr, myLogin } = input;
  const maxRounds = input.maxReviewRounds ?? DEFAULT_MAX_REVIEW_ROUNDS;

  const pull = await gh.getPullRequest(repo, pr);
  if (pull.state !== "open") {
    return { action: "abandoned", reason: `the pull request is ${pull.state}; there is nothing left to review` };
  }

  const reviews = await gh.getReviews(repo, pr);
  // Sorted by submission time rather than trusted to arrive in order: which of this agent's reviews
  // is the standing one decides whether the pull request gets touched again.
  const mine = sortReviews(reviews).filter((r) => r.author === myLogin);
  if (mine.length === 0) return { action: "none", reason: "this agent has not reviewed this pull request" };

  const latest: Review | undefined = mine.filter((r) => VERDICT_STATES.has(r.state)).at(-1);
  if (!latest) return { action: "none", reason: "this agent has left comments but no verdict on this pull request" };
  if (latest.state === "APPROVED") {
    return pull.headSha === latest.commitId
      ? { action: "approved", reason: `this agent approved at ${latest.commitId}` }
      : {
        action: "approved",
        reason: `this agent approved at ${latest.commitId}; the head has since moved to ${pull.headSha}, and re-affirmation is a later phase`,
      };
  }

  if (pull.headSha === latest.commitId) {
    return { action: "wait", reason: `no push since this agent requested changes at ${latest.commitId}` };
  }

  if (mine.length >= maxRounds) {
    return {
      action: "hold-for-human",
      reason: `review round cap reached (${mine.length} of ${maxRounds}); handing this pull request to a human`,
    };
  }

  // An outstanding team request counts as a human in flight: its members cannot be enumerated from
  // here, and a team is a group of people until proven otherwise.
  const requested = await gh.listRequestedReviewers(repo, pr);
  const humanInFlight = requested.teams.length > 0
    || humanReviewInFlight({ reviews, requestedUsers: requested.users, actingLogin: myLogin, knownAgentLogins: input.knownAgentLogins });
  if (humanInFlight) {
    return { action: "hold-for-human", reason: "a human review is in flight; this agent will not race it" };
  }

  return { action: "re-review", reason: `the head moved from ${latest.commitId} to ${pull.headSha} after this agent requested changes` };
}
