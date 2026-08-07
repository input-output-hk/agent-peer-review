// "Is a human already reviewing this pull request?" - the input to the safety gate's rail 7 (see
// gate.ts). Pure: no I/O, no clock, no randomness.
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

import type { Review } from "../model.js";

export interface HumanReviewInput {
  reviews: Review[];
  requestedUsers: string[];    // logins with an OPEN review request (teams are handled by the caller)
  actingLogin: string;         // the agent asking the question
  knownAgentLogins?: string[]; // other agent logins the caller knows about, e.g. a peer reviewer
}

/**
 * True when a human review is in flight, meaning either:
 *
 * 1. someone who is not a known agent has an open review request on the pull request (they have
 *    been asked and have not answered yet), or
 * 2. a review exists whose author is not a known agent.
 *
 * Every review state counts, including COMMENTED and DISMISSED. A human who has engaged with the
 * pull request at all is treated as in flight; distinguishing "engaged but finished" from "still
 * looking" is not something the REST surface can answer reliably, and guessing wrong would race
 * them.
 *
 * Logins are compared exactly, matching the rest of core. GitHub logins are unique
 * case-insensitively, so a case mismatch here can only fail toward "human", the safe direction.
 */
export function humanReviewInFlight(input: HumanReviewInput): boolean {
  // The acting agent is, by construction, an agent: its own pending review request or its own
  // prior review must never read as a human in flight.
  const agents = new Set<string>([input.actingLogin, ...(input.knownAgentLogins ?? [])]);
  if (input.requestedUsers.some((u) => !agents.has(u))) return true;
  return input.reviews.some((r) => !agents.has(r.author));
}
