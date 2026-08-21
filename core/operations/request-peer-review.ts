import type { GitHubGateway } from "../github.js";
import { TRIGGER } from "../labels.js";
import { createReview } from "./create.js";
import { DEFAULT_BOT_ALLOWLIST, confirmsBotAuthor, isAllowlistedDependencyBot } from "./approve-dependency-upgrade.js";

export interface RequestPeerReviewInput {
  repo: string;
  pr: number;
  /** Resolved by the caller (CLI flag, tool argument, or the configured default). Must be non-empty. */
  reviewers: string[];
  skills?: string[];
  /**
   * The dependency bots the steward path can take off this flow's hands. Defaults to
   * DEFAULT_BOT_ALLOWLIST, and it must stay the same list `approveDependencyUpgrade` accepts: this is
   * the only reason a pull request is refused here, so a name on one list and not the other would
   * leave a pull request refused by both.
   */
  botAllowlist?: string[];
}

export interface RequestPeerReviewResult {
  status: "requested" | "already-requested" | "bot-authored";
  /** The reviewers actually requested. Empty for "bot-authored": nothing was requested. */
  reviewers: string[];
  /** Why nothing was requested. Present only for "bot-authored". */
  reason?: string;
}

/**
 * GitHub's own answer to "what kind of account is this login", or "unknown" when it cannot be read.
 *
 * The gateway maps only 404 to "unknown"; a 403 or a 5xx propagates. That must not turn a peer
 * review request into an error, because this read is a refinement on a call that never made one
 * before: an unreachable users API is not a reason to stop asking humans for reviews. An unreadable
 * answer is the same as an absent one, so it lands on "unknown", where `confirmsBotAuthor` falls
 * back to the name shape and the common cases are still caught.
 */
async function readActorType(gh: GitHubGateway, login: string): Promise<"User" | "Bot" | "Organization" | "unknown"> {
  try {
    return await gh.getActorType(login);
  } catch {
    return "unknown";
  }
}

/**
 * Ask a peer agent for a review, at most once per head commit.
 *
 * A taskflow re-runs this on every tick, so it has to be idempotent, and the unit of idempotency is
 * the HEAD COMMIT: that is the invariant the rest of this package already keeps, for proposals and
 * for claim markers alike. The pull request is treated as already handled when it carries the
 * trigger label AND one of the target reviewers has either an open request or a review of the
 * current head.
 *
 * Every part of that is load-bearing. The label alone is not enough: it survives forever, and an
 * open request alone can belong to a human somebody else asked. An open request alone is not enough
 * either, and that was a livelock (issue #52): submitting a review clears the request natively, so
 * the tick after the peer answered saw a labeled pull request with no outstanding request, asked
 * again, and the peer reviewed again, forever, with the head never moving. Keyed on the head, the
 * loop converges after one round and a genuine author push is still a genuine new round.
 *
 * Any review state at the head counts, COMMENTED included. The question here is whether this exact
 * diff has been looked at, and a second opinion is a look; the round CAP in watchAndReReview asks a
 * different question ("how many verdicts has this agent spent") and so counts only verdicts.
 *
 * A pull request authored by an allowlisted DEPENDENCY bot is refused, with the reason, and nothing
 * is written. GitHub only forbids approving your OWN pull request, so this agent may review and
 * approve such a bot's itself: handing a machine-checkable dependency bump to another engineer's
 * agent adds a round trip and a person's queue for no gain (issue #48). That work belongs to the
 * steward path, `approveDependencyUpgrade`, which additionally verifies the diff is version-only.
 * This is a policy outcome, so it is a status rather than a throw.
 *
 * The refusal is deliberately narrow: only bots on the same allowlist the steward accepts. Any OTHER
 * bot is still requestable, and must be. A codegen or release bot opens pull requests carrying real
 * source changes, which no automated path here may approve or merge, so a peer review is exactly
 * what they need; refusing every bot would have left them with nobody looking at them at all.
 */
export async function requestPeerReview(gh: GitHubGateway, input: RequestPeerReviewInput): Promise<RequestPeerReviewResult> {
  const { repo, pr, reviewers } = input;
  if (reviewers.length === 0) {
    throw new Error('No reviewers: pass "reviewers" or set a default "reviewers" in ~/.agent-peer-review/config.json');
  }

  const pull = await gh.getPullRequest(repo, pr);
  // Checked before anything is written: a label added here and a request cancelled afterwards would
  // still have handed the pull request to a human's queue.
  //
  // Allowlist membership comes first, and it is the expensive question's gate as well as the policy
  // one: only a listed name can be refused, so an unlisted author never costs the extra actor-type
  // read at all. The bot confirmation is second because a listed NAME could in principle be taken by
  // a human account, and the allowlist has to mean "that bot" rather than "that string".
  const allowlist = input.botAllowlist ?? [...DEFAULT_BOT_ALLOWLIST];
  if (isAllowlistedDependencyBot(pull.author, allowlist)
    && confirmsBotAuthor(pull.author, await readActorType(gh, pull.author))) {
    return {
      status: "bot-authored",
      reviewers: [],
      reason: `the author "${pull.author}" is an allowlisted dependency bot, so this pull request belongs to the steward path (approveDependencyUpgrade), which may review and approve it itself, rather than to a peer agent`,
    };
  }
  if (pull.labels.includes(TRIGGER)) {
    const requested = await gh.listRequestedReviewers(repo, pr);
    if (reviewers.some((r) => requested.users.includes(r))) {
      return { status: "already-requested", reviewers };
    }
    // No outstanding request, which by itself says nothing: answering one clears it. So the reviews
    // are read too, and a review of THIS head by a target reviewer is the answer to this round.
    //
    // Logins are compared case-folded here, unlike the exact comparison above, because this is the
    // check that has to converge: a gateway spelling the login back as "Peer-Bot" where the config
    // says "peer-bot" would miss, re-request, and restore the very loop this closes. A miss in the
    // check above is harmless by comparison, since this one catches it a moment later.
    const targets = new Set(reviewers.map((r) => r.toLowerCase()));
    const reviews = await gh.getReviews(repo, pr);
    if (reviews.some((r) => targets.has(r.author.toLowerCase()) && r.commitId === pull.headSha)) {
      return { status: "already-requested", reviewers };
    }
  }

  const created = await createReview(gh, { repo, pr, reviewers, skills: input.skills ?? [] });
  return { status: "requested", reviewers: created.reviewers };
}
