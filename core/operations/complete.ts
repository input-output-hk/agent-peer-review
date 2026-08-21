import type { GitHubGateway } from "../github.js";
import type { Config, ReviewResult } from "../model.js";
import { ReviewResultSchema } from "../model.js";
import { parseMarkers, sortMarkers, PRIMARY_MARKER, isPrimaryReview } from "../claim-marker.js";
import { serializeMeta, type ReviewMeta } from "../review-meta.js";
import { buildReviewHistory, serializeReviewRecord, validateFindingProgress } from "../review-record.js";
import type { ReviewWorkspaceState } from "../workspace-state.js";

const EVENT_MAP = { approve: "APPROVE", "request-changes": "REQUEST_CHANGES", comment: "COMMENT" } as const;

export async function completeReview(
  deps: { gh: GitHubGateway; config: Config; workspace: ReviewWorkspaceState },
  input: ReviewResult,
): Promise<{ url: string; drifted: boolean; superseded: boolean }> {
  const { gh, config, workspace } = deps;
  const req = ReviewResultSchema.parse(input);
  const login = config.githubLogin ?? (await gh.getAuthenticatedLogin());
  const pr = await gh.getPullRequest(req.repo, req.pr);

  // Authenticate marker ownership with the comment author before any later delete. The marker's
  // reviewer field is untrusted text and is not authority to delete somebody else's comment.
  const own = sortMarkers(parseMarkers(await gh.listComments(req.repo, req.pr)))
    .filter((m) => m.marker.reviewer === login && m.comment.author === login);
  const mine = own[0];
  if (!mine) throw new Error(`No active claim by ${login} on ${req.repo}#${req.pr}; claim first.`);

  if (pr.state !== "open") throw new Error(`PR ${req.repo}#${req.pr} is ${pr.state}, not open.`);
  if (!workspace.clean) {
    throw new Error("Review completion refused: the local worktree or index is dirty.");
  }
  if (workspace.headSha !== mine.marker.sha) {
    throw new Error(`Review completion refused: local HEAD ${workspace.headSha} differs from claimed SHA ${mine.marker.sha}.`);
  }
  if (pr.headSha !== mine.marker.sha) {
    throw new Error(`Review completion refused: remote PR head ${pr.headSha} differs from claimed SHA ${mine.marker.sha}; claim again.`);
  }
  if (req.reviewedSha && req.reviewedSha !== mine.marker.sha) {
    throw new Error(`Review completion refused: reviewedSha ${req.reviewedSha} differs from claimed SHA ${mine.marker.sha}.`);
  }

  // A competing primary for THIS round is another author's review carrying the primary tag at the
  // same pinned commit (e.g. a promoted enricher posted it while this anchor was stalled). Human
  // reviews (no tag) and prior rounds (a different commit) do NOT count, so this anchor never
  // wrongly downgrades its verdict. When one exists, post a second-opinion COMMENT rather than a
  // competing primary, keeping the panel to a single primary in normal operation. A truly
  // simultaneous complete by two agents can still race (GitHub has no cross-review lock, see
  // ADR 0001); that is rare and both reviews remain visible.
  const reviews = await gh.getReviews(req.repo, req.pr);
  const history = buildReviewHistory(reviews, mine.marker.sha);
  const mode = req.mode ?? history.mode;
  if (mode !== history.mode) {
    throw new Error(`Review mode ${mode} does not match claim history mode ${history.mode}.`);
  }
  validateFindingProgress(req.findings, history, mode);
  const competing = reviews.some((r) => r.author !== login && isPrimaryReview(r.body) && r.commitId === mine.marker.sha);

  const event = competing ? "COMMENT" : EVENT_MAP[req.event];
  let body = competing
    ? `**Second opinion (${req.event}):**\n\n${req.summary}\n\n> A primary review already exists for this commit, so this is posted as a second opinion rather than a competing primary.`
    : req.summary;
  body += `\n\n${serializeReviewRecord({
    v: 1,
    reviewedSha: mine.marker.sha,
    mode,
    role: competing ? "second-opinion" : "primary",
    verdict: req.event,
    findings: req.findings ?? [],
  })}`;
  // Opt-in (Config.captureMetadata, default false): off, no metadata footer is added. On, a durable
  // footer is appended before the primary marker so a later dashboard sync can read
  // model/agent/role/verdict straight off the review body.
  if (config.captureMetadata) {
    const meta: ReviewMeta = {
      v: 1,
      model: mine.marker.model ?? config.model,
      agent: mine.marker.agent ?? config.agent,
      toolVersion: mine.marker.toolVersion ?? config.toolVersion,
      role: competing ? "second-opinion" : "primary",
      verdict: req.event,
      claimedAt: mine.marker.claimedAt,
      machine: mine.marker.machine,
      drifted: false,
    };
    body += `\n\n${serializeMeta(meta)}`;
  }
  if (!competing) body += `\n\n${PRIMARY_MARKER}`; // tag this as the round's primary review; must stay last

  const { url } = await gh.submitReview(req.repo, req.pr, { commitId: mine.marker.sha, event, body, comments: req.comments });
  // Delete every one of our own markers, not just the one we used: a claim race can leave a
  // duplicate behind, and none of them should survive once we have posted our review.
  for (const m of own) { try { await gh.deleteComment(req.repo, m.comment.id); } catch {} }
  return { url, drifted: false, superseded: competing };
}
