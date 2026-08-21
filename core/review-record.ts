import { z } from "zod";
import { isPrimaryReview } from "./claim-marker.js";
import {
  ReviewFindingSchema,
  ReviewModeSchema,
  type Review,
  type ReviewFinding,
  type ReviewHistory,
  type ReviewMode,
} from "./model.js";

const MAX_REVIEWED_SHAS = 12;
const MAX_HISTORY_FINDINGS = 30;
const MAX_ACCEPTED_RISKS = 20;

export const ReviewRecordSchema = z.object({
  v: z.literal(1),
  reviewedSha: z.string().min(7),
  mode: ReviewModeSchema,
  role: z.enum(["primary", "second-opinion"]),
  verdict: z.enum(["approve", "request-changes", "comment", "agree", "disagree", "mixed"]),
  findings: z.array(ReviewFindingSchema).max(20),
});
export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;

// Base64url keeps nested finding JSON out of the HTML marker grammar. The regex is therefore a
// bounded alphabet with no nested-brace or backtracking ambiguity even when a review quotes hostile
// marker-like text. As with the other markers, the last valid occurrence wins.
export const REVIEW_RECORD_MARKER = "<!-- agent-review:result ";
const REVIEW_RECORD_RE = /<!--\s*agent-review:result\s+([A-Za-z0-9_-]+)\s*-->/gs;

export function serializeReviewRecord(record: ReviewRecord): string {
  const parsed = ReviewRecordSchema.parse(record);
  return `${REVIEW_RECORD_MARKER}${Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url")} -->`;
}

export function parseReviewRecord(body: string): ReviewRecord | null {
  const matches = [...body.matchAll(REVIEW_RECORD_RE)];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    try {
      return ReviewRecordSchema.parse(JSON.parse(Buffer.from(matches[index][1], "base64url").toString("utf8")));
    } catch {
      // A quoted or attacker-authored look-alike is not history. Continue in case an earlier marker
      // in this same body is the valid one.
    }
  }
  return null;
}

const ordered = (reviews: Review[]): Review[] => [...reviews]
  .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.id - b.id);

function verdictOf(review: Review): string {
  return parseReviewRecord(review.body)?.verdict ?? review.state.toLowerCase().replaceAll("_", "-");
}

/**
 * Build the concise, normalized history served by claim.
 *
 * Current-head reviews are deliberately excluded: they belong to the panel round in progress, not
 * to the prior cycles that decide initial/rereview/convergence mode. Full historical review bodies
 * are never returned. Stable IDs let a later result dispose a finding without repeating prose.
 */
export function buildReviewHistory(reviews: Review[], currentSha: string): ReviewHistory {
  const prior = ordered(reviews).filter((review) => review.commitId !== currentSha);
  const primaries = prior.filter((review) => isPrimaryReview(review.body));
  // A cycle is a reviewed head, not a review row. A simultaneous-primary race or an old duplicate
  // request at one SHA must not advance the workflow into convergence on its own.
  const changesRequestedCycles = new Set(primaries
    .filter((review) => review.state === "CHANGES_REQUESTED")
    .map((review) => review.commitId)).size;
  const mode: ReviewMode = changesRequestedCycles >= 2
    ? "convergence"
    : primaries.length > 0 ? "rereview" : "initial";

  const reviewedShasAll = [...new Set(primaries.map((review) => review.commitId))];
  const reviewedShas = reviewedShasAll.slice(-MAX_REVIEWED_SHAS);
  const latestById = new Map<string, ReviewFinding>();
  for (const review of prior) {
    const record = parseReviewRecord(review.body);
    // GitHub's review row is the authority for the commit. A record claiming another SHA is stale
    // or forged metadata and cannot contribute exact-head findings.
    if (!record || record.reviewedSha !== review.commitId) continue;
    for (const finding of record.findings) {
      // Map.set does not refresh insertion order for an existing key. Delete first so the bounded
      // tail means "most recently disposed", keeping a still-open root cause in context even after
      // many unrelated findings have appeared.
      latestById.delete(finding.id);
      latestById.set(finding.id, finding);
    }
  }
  const allFindings = [...latestById.values()];
  const summarize = (finding: ReviewFinding) => ({
    id: finding.id,
    title: finding.title,
    severity: finding.severity,
    scope: finding.scope,
    status: finding.status,
    blocking: finding.blocking,
    relatedFindingId: finding.relatedFindingId ?? null,
    followUpIssue: finding.followUpIssue ?? null,
  });
  const bounded = allFindings.slice(-MAX_HISTORY_FINDINGS).map(summarize);
  // Accepted safety decisions get a separate bounded window. Otherwise thirty unrelated later IDs
  // could evict the decision and let a reviewer reopen it without the required new evidence.
  const acceptedAll = allFindings.filter((finding) =>
    finding.status === "accepted-risk" || finding.scope === "accepted-risk");
  const acceptedRisks = acceptedAll.slice(-MAX_ACCEPTED_RISKS).map(summarize);

  return {
    mode,
    changesRequestedCycles,
    reviewedShas,
    findings: bounded,
    acceptedRisks,
    lastVerdict: primaries.length > 0 ? verdictOf(primaries.at(-1)!) : null,
    truncated: reviewedShasAll.length > reviewedShas.length
      || allFindings.length > bounded.length
      || acceptedAll.length > acceptedRisks.length,
  };
}

const ACTIVE_STATUSES = new Set(["open", "still-open", "regressed"]);

/** Enforce the history-dependent part of review admissibility that zod cannot decide in isolation. */
export function validateFindingProgress(
  findings: ReviewFinding[] | undefined,
  history: ReviewHistory,
  mode: ReviewMode,
): void {
  const next = new Map((findings ?? []).map((finding) => [finding.id, finding]));
  const prior = new Map([...history.acceptedRisks, ...history.findings].map((finding) => [finding.id, finding]));

  for (const finding of history.findings.filter((item) => ACTIVE_STATUSES.has(item.status))) {
    if (!next.has(finding.id)) {
      throw new Error(`Re-review must classify prior finding ${finding.id} as resolved, still-open, regressed, superseded, accepted-risk, or follow-up.`);
    }
  }

  for (const finding of findings ?? []) {
    const previous = prior.get(finding.id);
    const wasAccepted = previous?.status === "accepted-risk" || previous?.scope === "accepted-risk";
    if (wasAccepted && ACTIVE_STATUSES.has(finding.status) && !finding.reopenedBecause) {
      throw new Error(`Finding ${finding.id} was accepted risk; reopening it requires new evidence in reopenedBecause.`);
    }
  }
  validateNewFindingAdmissibility(findings, history, mode);
}

/** Apply convergence-mode limits to genuinely new findings without requiring prior disposition. */
export function validateNewFindingAdmissibility(
  findings: ReviewFinding[] | undefined,
  history: ReviewHistory,
  mode: ReviewMode,
): void {
  if (mode !== "convergence") return;
  const priorIds = new Set(history.findings.map((finding) => finding.id));
  for (const finding of findings ?? []) {
    if (!finding.blocking || priorIds.has(finding.id)) continue;
    if (!(["critical", "high"] as string[]).includes(finding.severity)
      || !(["introduced", "regression"] as string[]).includes(finding.scope)) {
      throw new Error(`New convergence-mode blocker ${finding.id} must be critical/high and introduced by the PR or its latest fix.`);
    }
  }
}
