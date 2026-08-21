import { ClaimMarkerSchema, type ClaimMarker, type IssueComment } from "./model.js";

// `[^{}]*` (not a lazy `.*?`) keeps this linear on adversarial comment bodies: the claim JSON is
// flat (no nested braces), so a bounded character class matches it without catastrophic
// backtracking (see the js/polynomial-redos code-scanning alert).
const MARKER_RE = /<!--\s*agent-review:claim\s+(\{[^{}]*\})\s*-->/s;

// Hidden tag placed in the body of the anchor's PRIMARY review, so a later completeReview or
// enrichReview can recognize this round's primary precisely: a human review (no tag) or a second
// opinion (no tag) does not count, and a prior round's primary lives at a different commit.
export const PRIMARY_MARKER = "<!-- agent-review:primary -->";

// A review is THIS workflow's primary only when its body ENDS with the tag (completeReview appends
// it last). Matching by position, not a bare substring, keeps a human review that merely quotes
// the marker string from being mistaken for a primary.
export function isPrimaryReview(body: string): boolean {
  return body.trimEnd().endsWith(PRIMARY_MARKER);
}

export function serializeMarker(m: ClaimMarker): string {
  const machine = m.machine ? ` (${m.machine})` : "";
  const human = `Claimed by ${m.reviewer}'s review agent${machine} at ${m.claimedAt}, pinned to ${m.sha}.`;
  return `${human}\n<!-- agent-review:claim ${JSON.stringify(m)} -->`;
}

export function parseMarkers(comments: IssueComment[]): Array<{ comment: IssueComment; marker: ClaimMarker }> {
  const out: Array<{ comment: IssueComment; marker: ClaimMarker }> = [];
  for (const comment of comments) {
    const match = MARKER_RE.exec(comment.body);
    if (!match) continue;
    try {
      out.push({ comment, marker: ClaimMarkerSchema.parse(JSON.parse(match[1])) });
    } catch {
      // malformed marker: ignore
    }
  }
  return out;
}

export function sortMarkers(
  markers: Array<{ comment: IssueComment; marker: ClaimMarker }>,
): Array<{ comment: IssueComment; marker: ClaimMarker }> {
  return [...markers].sort((a, b) =>
    a.marker.claimedAt.localeCompare(b.marker.claimedAt) || a.comment.id - b.comment.id);
}
