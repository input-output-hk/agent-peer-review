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
  status: "requested" | "already-requested";
  reviewers: string[];
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
 */
export async function requestPeerReview(gh: GitHubGateway, input: RequestPeerReviewInput): Promise<RequestPeerReviewResult> {
  const { repo, pr, reviewers } = input;
  if (reviewers.length === 0) {
    throw new Error('No reviewers: pass "reviewers" or set a default "reviewers" in ~/.agent-peer-review/config.json');
  }

  const pull = await gh.getPullRequest(repo, pr);
  if (pull.labels.includes(TRIGGER)) {
    const requested = await gh.listRequestedReviewers(repo, pr);
    if (reviewers.some((r) => requested.users.includes(r))) {
      return { status: "already-requested", reviewers };
    }
  }

  const created = await createReview(gh, { repo, pr, reviewers, skills: input.skills ?? [] });
  return { status: "requested", reviewers: created.reviewers };
}
