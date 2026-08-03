import type { GitHubGateway } from "../github.js";
import type { Config, ReviewResult } from "../model.js";
import { ReviewResultSchema } from "../model.js";
import { parseMarkers, sortMarkers, PRIMARY_MARKER, isPrimaryReview } from "../claim-marker.js";

const EVENT_MAP = { approve: "APPROVE", "request-changes": "REQUEST_CHANGES", comment: "COMMENT" } as const;

export async function completeReview(
  deps: { gh: GitHubGateway; config: Config },
  input: ReviewResult,
): Promise<{ url: string; drifted: boolean; superseded: boolean }> {
  const { gh, config } = deps;
  const req = ReviewResultSchema.parse(input);
  const login = config.githubLogin ?? (await gh.getAuthenticatedLogin());
  const pr = await gh.getPullRequest(req.repo, req.pr);

  const own = sortMarkers(parseMarkers(await gh.listComments(req.repo, req.pr))).filter((m) => m.marker.reviewer === login);
  const mine = own[0];
  if (!mine) throw new Error(`No active claim by ${login} on ${req.repo}#${req.pr}; claim first.`);

  // A competing primary for THIS round is another author's review carrying the primary tag at the
  // same pinned commit (e.g. a promoted enricher posted it while this anchor was stalled). Human
  // reviews (no tag) and prior rounds (a different commit) do NOT count, so this anchor never
  // wrongly downgrades its verdict. When one exists, post a second-opinion COMMENT rather than a
  // competing primary, keeping the panel to a single primary in normal operation. A truly
  // simultaneous complete by two agents can still race (GitHub has no cross-review lock, see
  // ADR 0001); that is rare and both reviews remain visible.
  const reviews = await gh.getReviews(req.repo, req.pr);
  const competing = reviews.some((r) => r.author !== login && isPrimaryReview(r.body) && r.commitId === mine.marker.sha);

  const drifted = pr.headSha !== mine.marker.sha;

  const event = competing ? "COMMENT" : EVENT_MAP[req.event];
  let body = competing
    ? `**Second opinion (${req.event}):**\n\n${req.summary}\n\n> A primary review already exists for this commit, so this is posted as a second opinion rather than a competing primary.`
    : req.summary;
  if (drifted) {
    body += `\n\n> Note: reviewed at pinned commit ${mine.marker.sha.slice(0, 7)}; PR head is now ${pr.headSha.slice(0, 7)}.`;
  }
  if (!competing) body += `\n\n${PRIMARY_MARKER}`; // tag this as the round's primary review

  const { url } = await gh.submitReview(req.repo, req.pr, { commitId: mine.marker.sha, event, body, comments: req.comments });
  // Delete every one of our own markers, not just the one we used: a claim race can leave a
  // duplicate behind, and none of them should survive once we have posted our review.
  for (const m of own) { try { await gh.deleteComment(req.repo, m.comment.id); } catch {} }
  return { url, drifted, superseded: competing };
}
