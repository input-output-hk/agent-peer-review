// Hidden marker for propose-mode actions, so an operation that runs every tick can recognize a
// proposal it already posted instead of posting it again. Mirrors core/claim-marker.ts: a versioned
// HTML comment carrying flat JSON, appended to the end of the visible comment body.
//
// Parsing is a plain indexOf scan, not a regex: comment bodies are attacker-influenced and this
// repository runs CodeQL, so nothing here may backtrack.

import type { IssueComment } from "../model.js";

export interface ActionMarker {
  v: 1;
  kind: "expedite-proposal" | "dep-upgrade-proposal";
  headSha: string;              // the head the proposal was evaluated against
  decision: "auto" | "propose"; // what the gate decided at the time (always "propose" for a posted proposal)
  at: string;                   // ISO timestamp supplied by the caller; this module reads no clock
}

const OPEN = "<!-- agent-review:action ";
const CLOSE = " -->";

// A genuine payload is five short flat fields (roughly 120 characters). Anything longer than this
// is not one, and refusing to look past the bound keeps each scan step constant-time: without it, a
// body stuffed with unterminated OPEN tokens would make every step scan to the end of the body.
const MAX_PAYLOAD = 1024;

export function buildActionMarker(m: ActionMarker): string {
  return `${OPEN}${JSON.stringify(m)}${CLOSE}`;
}

// Exact-prefix matching (no `\s*` tolerance) is what keeps this linear. Every marker in the wild is
// written by buildActionMarker above, so the spacing is fixed by construction.
function extractMarker(body: string): ActionMarker | null {
  let found: ActionMarker | null = null;
  let from = 0;
  for (;;) {
    const open = body.indexOf(OPEN, from);
    if (open < 0) break;
    const payloadStart = open + OPEN.length;
    const window = body.slice(payloadStart, payloadStart + MAX_PAYLOAD + CLOSE.length);
    const relativeClose = window.indexOf(CLOSE);
    const parsed = relativeClose < 0 ? null : parseMarker(window.slice(0, relativeClose));
    if (parsed) {
      // Last parseable marker wins, matching review-meta.ts: the genuine marker is appended last,
      // so an earlier look-alike quoted in the visible prose must lose to it.
      found = parsed;
      from = payloadStart + relativeClose + CLOSE.length;
    } else {
      // A bare or garbled OPEN token: resume from just past THIS token, never past the close it
      // happened to find. Skipping to that close would swallow a genuine marker sitting between the
      // two, which is how an attacker-supplied `<!-- agent-review:action ` fragment earlier in the
      // body would otherwise hide our own marker and defeat idempotency. `from` still advances by
      // at least OPEN.length every iteration, so the scan terminates and stays linear.
      from = payloadStart;
    }
  }
  return found;
}

// Hand-validated instead of zod-parsed: the expedition modules stay dependency-free, and the shape
// is five flat fields. Anything that does not match exactly is treated as garbage and ignored.
function parseMarker(json: string): ActionMarker | null {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return null; }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (m.v !== 1) return null;
  if (m.kind !== "expedite-proposal" && m.kind !== "dep-upgrade-proposal") return null;
  if (typeof m.headSha !== "string" || m.headSha.length === 0) return null;
  if (m.decision !== "auto" && m.decision !== "propose") return null;
  if (typeof m.at !== "string" || m.at.length === 0) return null;
  return { v: 1, kind: m.kind, headSha: m.headSha, decision: m.decision, at: m.at };
}

/**
 * Find the action marker in each of `comments`, in input order, skipping comments that carry none
 * or carry only unparseable ones. Callers filter `comments` to their OWN authored comments before
 * calling: a marker in someone else's comment says nothing about what this agent has posted.
 */
export function findActionMarkers(comments: IssueComment[]): Array<{ comment: IssueComment; marker: ActionMarker }> {
  const out: Array<{ comment: IssueComment; marker: ActionMarker }> = [];
  for (const comment of comments) {
    const marker = extractMarker(comment.body);
    if (marker) out.push({ comment, marker });
  }
  return out;
}
