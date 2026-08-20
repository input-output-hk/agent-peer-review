// "Is a human still deciding about this pull request, and has one already refused it?" - the two
// inputs to the safety gate's rail 7 (see gate.ts). Pure: no I/O, no clock, no randomness.
//
// Identity here comes from ONE place: the caller's list of agent logins. An actor not on that list
// is a human, full stop. In particular the agent meta footer (review-meta.ts) is deliberately NOT
// consulted: it is self-asserted text in a review body, so anyone can paste it, and letting it
// promote an unrecognized login to "agent" would hand any human a one-line way to switch off the
// rail that exists to keep the agent from racing them. The footer can at most agree with a login
// the caller already listed, which adds nothing, so it is not read at all.
//
// The cost of the strict reading is that an agent whose login the caller forgot to configure holds
// the pull request for a human. That is the direction to be wrong in.
//
// What this module used to answer, and why that was a bug (issue #57). One boolean called
// "humanReviewInFlight" was true as soon as ANY human had left ANY review, in any state. A GitHub
// review is permanent history, so that boolean could never become false again, and the review that
// satisfied the required-approvals rule was the same event that failed this rail: on every repository
// where a human ever reviews, the auto path was unreachable. The question had to be split, because
// "someone is mid-review" and "someone has ruled against this" are different facts with different
// answers, and a finished, favourable review is neither of them.

import type { Review } from "../model.js";
import { standingVerdicts } from "./protection.js";

export interface HumanReviewInput {
  reviews: Review[];
  requestedUsers: string[];    // logins with an OPEN review request (teams are handled by the caller)
  actingLogin: string;         // the agent asking the question
  knownAgentLogins?: string[]; // other agent logins the caller knows about, e.g. a peer reviewer
}

/**
 * The two facts about humans that rail 7 acts on. Both false means no human is standing in the way.
 */
export interface HumanReviewStatus {
  /**
   * A human has an OPEN review request: they were asked and have not answered. This is the real "in
   * flight", and the only state from which racing a human is even possible.
   */
  pendingRequest: boolean;
  /**
   * A human's standing verdict is CHANGES_REQUESTED. Not a race but a position: it blocks because a
   * person has ruled against the change and has not withdrawn that ruling.
   *
   * Deliberately NOT filtered by commit, unlike the approvals rail 5 counts (see ApprovalScope in
   * protection.ts). The asymmetry is the fail-safe direction of each question: an approval of an old
   * commit says nothing about the code that would merge, so it must not COUNT, while a refusal of an
   * old commit is a person's outstanding objection until they replace it with another verdict, so it
   * must still BLOCK.
   */
  changesRequested: boolean;
}

/**
 * Read both facts from the pull request's reviews and open review requests.
 *
 * What is deliberately not here:
 *
 * - **A human's standing APPROVED.** It is the outcome the workflow wants. It already counts toward
 *   the required-approvals rule (rail 5), and counting it a second time as an obstacle is exactly
 *   the deadlock in issue #57.
 * - **A COMMENTED review**, whoever left it and whenever. A comment is not a verdict, which is
 *   already this package's rule everywhere else (see VERDICT_STATES in protection.ts): it states no
 *   position, and GitHub's own protection rules do not count one either. Ignoring only comments
 *   OLDER than the head was the alternative, and it is the same bug in miniature, since a pull request
 *   whose head never moves again would be held forever by one drive-by note. A human who wants a
 *   pull request stopped has the button for it, and pressing it lands in `changesRequested` above.
 * - **A DISMISSED review.** A dismissal retires a verdict; there is no position left to respect. The
 *   dangerous case, a maintainer dismissing THIS agent's own approval, is not visible here at all
 *   (dismissing creates no review by the dismisser) and is handled where it can be seen, by
 *   approveDependencyUpgrade.
 * - **A PENDING review**, which would be the perfect "mid-review" signal and is unusable: GitHub
 *   shows an unsubmitted review to nobody but its author.
 *
 * Logins are compared exactly, matching the rest of core. GitHub logins are unique
 * case-insensitively, so a case mismatch here can only fail toward "human", the safe direction.
 */
export function humanReviewStatus(input: HumanReviewInput): HumanReviewStatus {
  // The acting agent is, by construction, an agent: its own pending review request or its own
  // standing verdict must never read as a human.
  const agents = new Set<string>([input.actingLogin, ...(input.knownAgentLogins ?? [])]);
  // The standing verdict comes from protection.ts rather than from a scan written here, so rail 7 and
  // rail 5 can never disagree about which of a login's reviews is the live one.
  const humanRefusal = [...standingVerdicts(input.reviews).values()]
    .some((v) => v.state === "CHANGES_REQUESTED" && !agents.has(v.login));
  return {
    pendingRequest: input.requestedUsers.some((u) => !agents.has(u)),
    changesRequested: humanRefusal,
  };
}
