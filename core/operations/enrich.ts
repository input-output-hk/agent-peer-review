import type { GitHubGateway } from "../github.js";
import type { Config, Enrichment } from "../model.js";
import { EnrichmentSchema } from "../model.js";
import { parseMarkers, sortMarkers, isPrimaryReview } from "../claim-marker.js";
import { serializeMeta, type ReviewMeta } from "../review-meta.js";
import {
  buildReviewHistory,
  parseReviewRecord,
  serializeReviewRecord,
  validateNewFindingAdmissibility,
} from "../review-record.js";
import type { ReviewWorkspaceState } from "../workspace-state.js";

/** One shared staleness policy for every adapter; user-facing poll deadlines do not alter it. */
export const DEFAULT_CLAIM_TTL_MS = 30 * 60_000;

export async function enrichReview(
  deps: { gh: GitHubGateway; config: Config; ttlMs: number; nowMs: number; workspace: ReviewWorkspaceState },
  input: { repo: string; pr: number } & Enrichment,
): Promise<{ status: "enriched" | "waiting" | "promote"; url?: string }> {
  const { gh, config, ttlMs, nowMs, workspace } = deps;
  const enrichment = EnrichmentSchema.parse({
    overallVerdict: input.overallVerdict,
    summary: input.summary,
    newFindings: input.newFindings,
    reviewedSha: input.reviewedSha,
    mode: input.mode,
    findings: input.findings,
    assessments: input.assessments,
  });
  const login = config.githubLogin ?? (await gh.getAuthenticatedLogin());

  const sorted = sortMarkers(parseMarkers(await gh.listComments(input.repo, input.pr)));
  const mine = sorted.filter((m) => m.marker.reviewer === login && m.comment.author === login)[0];
  if (!mine) throw new Error(`No active claim by ${login} on ${input.repo}#${input.pr}; claim first.`);

  // This round's primary is another author's tagged review AT THIS ENRICHER'S pinned commit.
  // Scoping to the commit (as completeReview does) ignores a PRIOR round's tagged primary at an
  // older commit, so the enricher never posts its second opinion against a stale review. Human
  // reviews and second opinions carry no end tag and are ignored.
  const reviews = await gh.getReviews(input.repo, input.pr);
  const primary = reviews.filter((r) => r.author !== login && isPrimaryReview(r.body) && r.commitId === mine.marker.sha)
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt) || b.id - a.id)[0];

  if (primary) {
    const pr = await gh.getPullRequest(input.repo, input.pr);
    if (pr.state !== "open") throw new Error(`PR ${input.repo}#${input.pr} is ${pr.state}, not open.`);
    if (!workspace.clean) throw new Error("Review enrichment refused: the local worktree or index is dirty.");
    if (workspace.headSha !== mine.marker.sha) {
      throw new Error(`Review enrichment refused: local HEAD ${workspace.headSha} differs from claimed SHA ${mine.marker.sha}.`);
    }
    if (pr.headSha !== mine.marker.sha) {
      throw new Error(`Review enrichment refused: remote PR head ${pr.headSha} differs from claimed SHA ${mine.marker.sha}; claim again.`);
    }
    if (enrichment.reviewedSha && enrichment.reviewedSha !== mine.marker.sha) {
      throw new Error(`Review enrichment refused: reviewedSha ${enrichment.reviewedSha} differs from claimed SHA ${mine.marker.sha}.`);
    }

    const history = buildReviewHistory(reviews, mine.marker.sha);
    const mode = enrichment.mode ?? history.mode;
    if (mode !== history.mode) throw new Error(`Review mode ${mode} does not match claim history mode ${history.mode}.`);
    validateNewFindingAdmissibility(enrichment.findings, history, mode);

    const parsedPrimaryRecord = parseReviewRecord(primary.body);
    const primaryRecord = parsedPrimaryRecord?.reviewedSha === primary.commitId ? parsedPrimaryRecord : null;
    if (primaryRecord) {
      const assessments = new Map((enrichment.assessments ?? []).map((item) => [item.findingId, item]));
      for (const finding of primaryRecord.findings) {
        if (!assessments.has(finding.id)) throw new Error(`Second opinion must confirm or refute primary finding ${finding.id}.`);
      }
      const primaryIds = new Set(primaryRecord.findings.map((finding) => finding.id));
      for (const finding of enrichment.findings ?? []) {
        if (primaryIds.has(finding.id)) {
          throw new Error(`Finding ${finding.id} already belongs to the primary review; assess it instead of adding another example.`);
        }
      }
      if (enrichment.overallVerdict === "disagree") {
        const confirmsPrimaryBlocker = primaryRecord.findings.some((finding) =>
          finding.blocking && assessments.get(finding.id)?.disposition === "confirm");
        const addsBlocker = (enrichment.findings ?? []).some((finding) => finding.blocking && finding.confidence === "confirmed");
        if (!confirmsPrimaryBlocker && !addsBlocker) {
          throw new Error("A disagreeing second opinion requires a confirmed blocker, not speculative or duplicate hardening.");
        }
      }
    }

    let body = `**Second opinion (${enrichment.overallVerdict}):**\n\n${enrichment.summary}`;
    body += `\n\n${serializeReviewRecord({
      v: 1,
      reviewedSha: mine.marker.sha,
      mode,
      role: "second-opinion",
      verdict: enrichment.overallVerdict,
      findings: enrichment.findings ?? [],
    })}`;
    // Opt-in (Config.captureMetadata, default false): off, no metadata footer is added. On, a
    // durable footer is appended last (second opinions carry no primary marker, so there is
    // nothing the footer needs to precede).
    if (config.captureMetadata) {
      const meta: ReviewMeta = {
        v: 1,
        model: mine.marker.model ?? config.model,
        agent: mine.marker.agent ?? config.agent,
        toolVersion: mine.marker.toolVersion ?? config.toolVersion,
        role: "second-opinion",
        verdict: enrichment.overallVerdict,
        claimedAt: mine.marker.claimedAt,
        machine: mine.marker.machine,
      };
      body += `\n\n${serializeMeta(meta)}`;
    }
    const { url } = await gh.submitReview(input.repo, input.pr, { commitId: primary.commitId, event: "COMMENT", body, comments: enrichment.newFindings });
    // Delete every one of our own markers, not just the one we used: a claim race can leave a
    // duplicate behind, and none of them should survive once we have posted our second opinion.
    for (const m of sorted.filter((x) => x.marker.reviewer === login && x.comment.author === login)) { try { await gh.deleteComment(input.repo, m.comment.id); } catch {} }
    return { status: "enriched", url };
  }

  const anchor = sorted[0]?.marker;
  const anchorStale = !!anchor && anchor.reviewer !== login && nowMs - Date.parse(anchor.claimedAt) > ttlMs;
  if (!anchorStale) return { status: "waiting" };
  const survivors = sorted.filter((m) => m.marker.reviewer !== anchor!.reviewer);
  if (survivors[0]?.marker.reviewer !== login) return { status: "waiting" };

  // I am the earliest surviving reviewer, so I promote myself. Delete the stale anchor's
  // marker(s) first so the panel cannot deadlock if I also stall: the next-earliest survivor
  // then becomes the anchor and this same rule elects it in turn. In normal operation this keeps
  // the panel to a single primary (completeReview's guard degrades a late second completer to a
  // COMMENT); a truly simultaneous double-complete can still race, as completeReview notes.
  // A stale agent's genuine marker may be cleaned up, but a maintainer's comment that merely
  // asserts that reviewer's login must never be deleted. The GitHub author authenticates the
  // reviewer field for this destructive step.
  for (const m of sorted.filter((x) =>
    x.marker.reviewer === anchor!.reviewer && x.comment.author === anchor!.reviewer)) {
    try { await gh.deleteComment(input.repo, m.comment.id); } catch {}
  }
  return { status: "promote" };
}
