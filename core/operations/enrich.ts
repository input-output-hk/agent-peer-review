import type { GitHubGateway } from "../github.js";
import type { Config, Enrichment } from "../model.js";
import { EnrichmentSchema } from "../model.js";
import { parseMarkers, sortMarkers, isPrimaryReview } from "../claim-marker.js";
import { serializeMeta, type ReviewMeta } from "../review-meta.js";

export async function enrichReview(
  deps: { gh: GitHubGateway; config: Config; ttlMs: number; nowMs: number },
  input: { repo: string; pr: number } & Enrichment,
): Promise<{ status: "enriched" | "waiting" | "promote"; url?: string }> {
  const { gh, config, ttlMs, nowMs } = deps;
  const enrichment = EnrichmentSchema.parse({ overallVerdict: input.overallVerdict, summary: input.summary, newFindings: input.newFindings });
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
    let body = `**Second opinion (${enrichment.overallVerdict}):**\n\n${enrichment.summary}`;
    // Opt-in (Config.captureMetadata, default false): off, the body is unchanged from before this
    // feature existed. On, a durable meta footer is appended last (second opinions carry no
    // primary marker, so there is nothing the footer needs to precede).
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
