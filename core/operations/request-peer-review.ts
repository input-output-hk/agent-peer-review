import type { GitHubGateway } from "../github.js";
import { TRIGGER } from "../labels.js";
import { createReview } from "./create.js";
import { DEFAULT_BOT_ALLOWLIST, isAllowlistedDependencyBot } from "./approve-dependency-upgrade.js";

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
 * Whether an author name is a bot's, judged by name alone.
 *
 * A backstop for `getActorType`, not a replacement: the actor type is GitHub's own answer, but it is
 * read per login and a GitHub App shows up on a pull request under names the users API does not
 * resolve at all. The pull request behind issue #48 reported its author as `app/renovate`, which
 * reads as "unknown" through the users API, so both shapes are covered here: the `[bot]` suffix a
 * bot USER account carries (`dependabot[bot]`) and the `app/` prefix an App integration carries.
 * Lowercased first, because neither shape is a login GitHub compares case-sensitively.
 *
 * This only ever answers "is it really a bot" for a name that is already on the dependency-bot
 * allowlist, so a false positive costs nothing: the name had to be listed to get here. A linear
 * scan, no regex: the value comes from a pull request.
 */
function looksLikeBotAuthor(author: string): boolean {
  const name = author.toLowerCase();
  return name.endsWith("[bot]") || name.startsWith("app/");
}

/**
 * GitHub's own answer to "is this login a Bot account", or false when it cannot be read.
 *
 * The gateway maps only 404 to "unknown"; a 403 or a 5xx propagates. That must not turn a peer
 * review request into an error, because this read is a refinement on a call that never made it
 * before: an unreachable users API is not a reason to stop asking humans for reviews. Failing to
 * "not a bot" keeps the previous behavior, and the name shapes above still catch the common cases.
 */
async function actorTypeSaysBot(gh: GitHubGateway, login: string): Promise<boolean> {
  try {
    return (await gh.getActorType(login)) === "Bot";
  } catch {
    return false;
  }
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
    && (looksLikeBotAuthor(pull.author) || await actorTypeSaysBot(gh, pull.author))) {
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
  }

  const created = await createReview(gh, { repo, pr, reviewers, skills: input.skills ?? [] });
  return { status: "requested", reviewers: created.reviewers };
}
