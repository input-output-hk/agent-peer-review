// Renders the propose-mode comment: what the agent would have done, why it did not, and the hidden
// marker that makes re-posting idempotent. Pure string building, no I/O and no clock (the timestamp
// arrives inside the marker the caller built).

import { buildActionMarker, type ActionMarker } from "./action-marker.js";

export interface ProposalInput {
  /** What the agent would do, as a sentence fragment, e.g. "merge this pull request". */
  action: string;
  /** Change classes seen in the diff (classify.ts categories, or the dependency-upgrade class). */
  changeClasses: string[];
  /** Every reason the gate returned, verbatim. Rendered in order, one bullet each. */
  reasons: string[];
  headSha: string;
  /** Optional extra context, one bullet each, e.g. the dependency bumps in a manifest. */
  details?: string[];
  marker: ActionMarker;
}

/**
 * Defang HTML-comment delimiters in interpolated text.
 *
 * Everything this module renders can quote pull-request content: a gate reason names the changed
 * files that disqualified the change, a detail line names packages, and both come straight from an
 * attacker-influenced diff. A file named `src/x<!-- agent-review:action y.ts` would otherwise put a
 * stray marker token into OUR OWN comment, and a stray token is enough to break idempotency (the
 * agent stops recognizing its own proposal and re-posts it every tick) or to plant a marker that
 * outranks the genuine one.
 *
 * The comment body is the wrong place to fight that, so no token survives interpolation at all.
 * findActionMarkers is hardened against stray tokens independently; this is the other half, and
 * either one alone would do. Rendered output stays readable, which matters because a maintainer
 * reads these reasons to decide whether to act.
 *
 * Linear split/join, no regex: the input is attacker-influenced.
 */
const defang = (text: string): string => text.split("<!--").join("<!- -").split("-->").join("-- >");

const bullets = (lines: string[]): string => lines.map((l) => `- ${defang(l)}`).join("\n");

/** Build the proposal comment body, with the hidden marker appended last. */
export function renderProposal(input: ProposalInput): string {
  const facts = [
    `Head commit: \`${input.headSha}\``,
    `Change classes: ${input.changeClasses.length > 0 ? input.changeClasses.join(", ") : "none detected"}`,
    ...(input.details ?? []),
  ];
  const why = input.reasons.length > 0
    ? `I did not do it. The safety gate held it back:\n\n${bullets(input.reasons)}`
    // Not reachable from a gate decision of "propose" (autonomy alone always contributes a reason),
    // but a proposal with an empty reason list must still read as a complete sentence.
    : "I did not do it. Acting automatically is not enabled here.";

  return [
    "### Proposed action",
    "",
    `I would ${defang(input.action)}.`,
    "",
    bullets(facts),
    "",
    why,
    "",
    "Acting automatically is opt-in and off by default, so this agent stops at a proposal. A maintainer can take the action above by hand, or enable autonomy for this repository.",
    buildActionMarker(input.marker),
  ].join("\n");
}
