import type { GitHubGateway } from "../github.js";
import type { Config, Enrichment } from "../model.js";
import { EnrichmentSchema } from "../model.js";
import { parseMarkers } from "../claim-marker.js";

export async function enrichReview(
  deps: { gh: GitHubGateway; config: Config; ttlMs: number; nowMs: number },
  input: { repo: string; pr: number } & Enrichment,
): Promise<{ status: "enriched" | "waiting" | "promote"; url?: string }> {
  const { gh, config, ttlMs, nowMs } = deps;
  const enrichment = EnrichmentSchema.parse({ overallVerdict: input.overallVerdict, summary: input.summary, newFindings: input.newFindings });
  const login = config.githubLogin ?? (await gh.getAuthenticatedLogin());

  const markers = parseMarkers(await gh.listComments(input.repo, input.pr));
  const mine = markers.filter((m) => m.marker.reviewer === login).at(-1);
  if (!mine) throw new Error(`No active claim by ${login} on ${input.repo}#${input.pr}; claim first.`);

  const reviews = await gh.getReviews(input.repo, input.pr);
  const primary = reviews.filter((r) => r.author !== login)
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.id - b.id)[0];

  if (primary) {
    const body = `**Second opinion (${enrichment.overallVerdict}):**\n\n${enrichment.summary}`;
    const { url } = await gh.submitReview(input.repo, input.pr, { commitId: primary.commitId, event: "COMMENT", body, comments: enrichment.newFindings });
    await gh.deleteComment(input.repo, mine.comment.id);
    return { status: "enriched", url };
  }

  const earliest = [...markers].sort((a, b) =>
    a.marker.claimedAt.localeCompare(b.marker.claimedAt) || a.comment.id - b.comment.id)[0]?.marker;
  const stale = earliest && earliest.reviewer !== login && nowMs - Date.parse(earliest.claimedAt) > ttlMs;
  return { status: stale ? "promote" : "waiting" };
}
