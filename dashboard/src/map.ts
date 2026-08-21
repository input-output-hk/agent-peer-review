import { parseMeta, isPrimaryReview, PRIMARY_MARKER, type Review, type PullRequest } from "@input-output-hk/agent-review";

const STATE_VERDICT: Record<string, string> = {
  APPROVED: "approve",
  CHANGES_REQUESTED: "request-changes",
  COMMENTED: "comment",
};

export function verdictFromState(state: string): string | null {
  return STATE_VERDICT[state] ?? null;
}

// Bounded (no unbounded backtracking): the meta JSON is flat, so [^{}]* is safe and ReDoS-proof.
const META_BLOCK = /<!--\s*agent-review:meta\s+\{[^{}]*\}\s*-->/gs;

/** Remove the hidden meta footer(s) and the primary marker, leaving human-readable summary text. */
export function stripMarkers(body: string): string {
  return body.replace(META_BLOCK, "").split(PRIMARY_MARKER).join("").trim();
}

// Bound the attacker-controlled label and stop at a newline. Without the bound, repeated prefixes
// containing "(" create a fresh scan-to-end start point and make dashboard sync quadratic.
const SECOND_OPINION_PREFIX = /\*\*Second opinion \(([^)\n]{1,200})\):/;

export interface DerivedReview {
  isPrimary: boolean;
  role: string | null;
  verdict: string | null;
  summary: string;
  model: string | null;
  agent: string | null;
  toolVersion: string | null;
  machine: string | null;
  claimedAt: string | null;
  drifted: number | null;
}

export function deriveReviewFields(r: Review): DerivedReview {
  const isPrimary = isPrimaryReview(r.body);
  const summary = stripMarkers(r.body);
  const meta = parseMeta(r.body);
  if (meta) {
    return {
      isPrimary,
      role: meta.role,
      verdict: meta.verdict,
      summary,
      model: meta.model ?? null,
      agent: meta.agent ?? null,
      toolVersion: meta.toolVersion ?? null,
      machine: meta.machine ?? null,
      claimedAt: meta.claimedAt ?? null,
      drifted: meta.drifted === undefined ? null : meta.drifted ? 1 : 0,
    };
  }
  // Pre-Phase-0 or capture-off review: infer from the primary marker + body prefix.
  const base = { summary, model: null, agent: null, toolVersion: null, machine: null, claimedAt: null, drifted: null };
  if (isPrimary) {
    return { isPrimary, role: "primary", verdict: verdictFromState(r.state), ...base };
  }
  const m = SECOND_OPINION_PREFIX.exec(r.body);
  return { isPrimary, role: "second-opinion", verdict: m ? m[1] : null, ...base };
}

export function participantsOf(pull: PullRequest, reviews: Review[]): Array<{ login: string; role: "author" | "reviewer" }> {
  const out: Array<{ login: string; role: "author" | "reviewer" }> = [{ login: pull.author, role: "author" }];
  const seen = new Set<string>();
  for (const r of reviews) {
    if (!seen.has(r.author)) {
      seen.add(r.author);
      out.push({ login: r.author, role: "reviewer" });
    }
  }
  return out;
}
