import { z } from "zod";
import type { GitHubGateway } from "../github.js";
import type { ReviewWorkspaceState } from "../workspace-state.js";
import { findPassedSelfReview, parseSelfReviewMarker, serializeSelfReviewMarker } from "../self-review.js";

export const RecordSelfReviewInputSchema = z.object({
  repo: z.string().regex(/^[^/]+\/[^/]+$/),
  pr: z.number().int().positive(),
  reviewedSha: z.string().min(7),
  whatChanged: z.string().min(20).max(4_000),
  howVerified: z.string().min(20).max(4_000),
  whyReady: z.string().min(20).max(4_000),
});
export type RecordSelfReviewInput = z.infer<typeof RecordSelfReviewInputSchema>;
export interface RecordSelfReviewResult {
  status: "recorded" | "already-recorded";
  commentId: number;
  headSha: string;
}

/** Record a successful implementer self-review at one exact, clean pull-request head. */
export async function recordSelfReview(
  deps: { gh: GitHubGateway; workspace: ReviewWorkspaceState },
  input: RecordSelfReviewInput,
): Promise<RecordSelfReviewResult> {
  const req = RecordSelfReviewInputSchema.parse(input);
  const { gh, workspace } = deps;
  const [pull, login, comments] = await Promise.all([
    gh.getPullRequest(req.repo, req.pr),
    gh.getAuthenticatedLogin(),
    gh.listComments(req.repo, req.pr),
  ]);
  if (pull.state !== "open") throw new Error(`PR ${req.repo}#${req.pr} is ${pull.state}, not open.`);
  if (login.toLowerCase() !== pull.author.toLowerCase()) {
    throw new Error(`Self-review must be recorded by pull request author ${pull.author}, not ${login}.`);
  }
  if (!workspace.clean) throw new Error("Self-review refused: the local worktree or index is dirty.");
  if (workspace.headSha !== req.reviewedSha) {
    throw new Error(`Self-review refused: local HEAD ${workspace.headSha} differs from reviewedSha ${req.reviewedSha}.`);
  }
  if (pull.headSha !== req.reviewedSha) {
    throw new Error(`Self-review refused: remote PR head ${pull.headSha} differs from reviewedSha ${req.reviewedSha}.`);
  }

  const existing = findPassedSelfReview(comments, pull.author, req.reviewedSha);
  if (existing) return { status: "already-recorded", commentId: existing.id, headSha: req.reviewedSha };

  // Keep exactly one live self-review summary. Only delete comments whose GitHub author authenticates
  // the marker; attacker-authored marker text is never deletion authority.
  for (const comment of comments) {
    const marker = parseSelfReviewMarker(comment.body);
    if (comment.author.toLowerCase() === login.toLowerCase()
      && marker?.author.toLowerCase() === login.toLowerCase()) {
      try { await gh.deleteComment(req.repo, comment.id); } catch {}
    }
  }
  const body = [
    "## Self-review",
    "",
    "### What changed",
    req.whatChanged,
    "",
    "### How it was fixed and verified",
    req.howVerified,
    "",
    "### Why this is ready for peer review",
    req.whyReady,
    "",
    serializeSelfReviewMarker({ v: 1, author: login, sha: req.reviewedSha, status: "passed" }),
  ].join("\n");
  const comment = await gh.createComment(req.repo, req.pr, body);
  return { status: "recorded", commentId: comment.id, headSha: req.reviewedSha };
}
