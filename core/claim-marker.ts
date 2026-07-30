import { ClaimMarkerSchema, type ClaimMarker, type IssueComment } from "./model.js";

const MARKER_RE = /<!--\s*agent-review:claim\s+(\{.*?\})\s*-->/s;

export function serializeMarker(m: ClaimMarker): string {
  const human = `Claimed by ${m.reviewer}'s review agent (${m.machine}) at ${m.claimedAt}, pinned to ${m.sha}.`;
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
      // malformed marker — ignore
    }
  }
  return out;
}
