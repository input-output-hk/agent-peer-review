import type { GitHubGateway } from "../github.js";
import { TRIGGER } from "../labels.js";
import { createReview } from "./create.js";

export interface RequestPeerReviewInput {
  repo: string;
  pr: number;
  /** Resolved by the caller (CLI flag, tool argument, or the configured default). Must be non-empty. */
  reviewers: string[];
  skills?: string[];
}

export interface RequestPeerReviewResult {
  status: "requested" | "already-requested" | "bot-authored";
  /** The reviewers actually requested. Empty for "bot-authored": nothing was requested. */
  reviewers: string[];
  /** Why nothing was requested. Present only for "bot-authored". */
  reason?: string;
}

/**
 * Whether an author name is a bot's, judged by name alone.
 *
 * A backstop for `getActorType`, not a replacement: the actor type is GitHub's own answer, but it is
 * read per login and a GitHub App shows up on a pull request under names the users API does not
 * resolve at all. The pull request behind issue #48 reported its author as `app/renovate`, which
 * reads as "unknown" through the users API, so both shapes are covered here: the `[bot]` suffix a
 * bot USER account carries (`dependabot[bot]`) and the `app/` prefix an App integration carries.
 *
 * Getting this wrong in the false-positive direction costs a peer review request that the steward
 * path handles instead; getting it wrong in the other direction is what issue #48 is about. A linear
 * scan, no regex: the value comes from a pull request.
 */
function looksLikeBotAuthor(author: string): boolean {
  return author.endsWith("[bot]") || author.startsWith("app/");
}

/**
 * Ask a peer agent for a review, at most once per pull request.
 *
 * A taskflow re-runs this on every tick, so it has to be idempotent. The pull request is treated as
 * already handled when it carries the trigger label AND at least one of the target reviewers still
 * has an open review request: both halves matter, because the label alone survives a request the
 * reviewer has already answered (submitting a review clears the request natively), and an open
 * request alone can belong to a human asked by someone else.
 *
 * Requesting again after the peer has reviewed is intentional, not a bug: that is a new round.
 *
 * A bot-authored pull request is refused, with the reason, and nothing is written. GitHub only
 * forbids approving your OWN pull request, so this agent may review and approve a bot's itself:
 * handing a machine-checkable dependency bump to another engineer's agent adds a round trip and a
 * person's queue for no gain (issue #48). That work belongs to the steward path,
 * `approveDependencyUpgrade`, which additionally verifies the diff is version-only. This is a policy
 * outcome, so it is a status rather than a throw.
 */
export async function requestPeerReview(gh: GitHubGateway, input: RequestPeerReviewInput): Promise<RequestPeerReviewResult> {
  const { repo, pr, reviewers } = input;
  if (reviewers.length === 0) {
    throw new Error('No reviewers: pass "reviewers" or set a default "reviewers" in ~/.agent-peer-review/config.json');
  }

  const pull = await gh.getPullRequest(repo, pr);
  // Before anything is written: a label added here and a request cancelled afterwards would still
  // have handed the pull request to a human's queue. The name check runs first so the common bot
  // shapes cost no extra API call; getActorType is what confirms a name that does not announce
  // itself.
  if (looksLikeBotAuthor(pull.author) || (await gh.getActorType(pull.author)) === "Bot") {
    return {
      status: "bot-authored",
      reviewers: [],
      reason: `the author "${pull.author}" is a bot, so this pull request belongs to the steward path (approveDependencyUpgrade), which may review and approve it itself, rather than to a peer agent`,
    };
  }
  if (pull.labels.includes(TRIGGER)) {
    const requested = await gh.listRequestedReviewers(repo, pr);
    if (reviewers.some((r) => requested.users.includes(r))) {
      return { status: "already-requested", reviewers };
    }
  }

  const created = await createReview(gh, { repo, pr, reviewers, skills: input.skills ?? [] });
  return { status: "requested", reviewers: created.reviewers };
}
