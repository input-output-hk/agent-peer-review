import type { GitHubGateway } from "../github.js";
import type { Config, ReviewResult } from "../model.js";
import { ReviewResultSchema } from "../model.js";
import { parseMarkers } from "../claim-marker.js";

const EVENT_MAP = { approve: "APPROVE", "request-changes": "REQUEST_CHANGES", comment: "COMMENT" } as const;

export async function completeReview(
  deps: { gh: GitHubGateway; config: Config },
  input: ReviewResult,
): Promise<{ url: string; drifted: boolean }> {
  const { gh, config } = deps;
  const req = ReviewResultSchema.parse(input);
  const login = config.githubLogin ?? (await gh.getAuthenticatedLogin());
  const pr = await gh.getPullRequest(req.repo, req.pr);

  const mine = parseMarkers(await gh.listComments(req.repo, req.pr)).filter((m) => m.marker.reviewer === login).at(-1);
  if (!mine) throw new Error(`No active claim by ${login} on ${req.repo}#${req.pr}; claim first.`);

  const drifted = pr.headSha !== mine.marker.sha;
  const body = drifted
    ? `${req.summary}\n\n> Note: reviewed at pinned commit ${mine.marker.sha.slice(0, 7)}; PR head is now ${pr.headSha.slice(0, 7)}.`
    : req.summary;

  const { url } = await gh.submitReview(req.repo, req.pr, { commitId: mine.marker.sha, event: EVENT_MAP[req.event], body, comments: req.comments });
  await gh.deleteComment(req.repo, mine.comment.id); // clear the claim so a re-request starts fresh
  return { url, drifted };
}
