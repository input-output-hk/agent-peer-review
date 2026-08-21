import type { GitHubGateway } from "../github.js";
import { ReviewRequestSchema, type ReviewRequest } from "../model.js";
import { composeRequestLabels } from "../labels.js";
import { findPassedSelfReview } from "../self-review.js";

export async function createReview(gh: GitHubGateway, input: ReviewRequest): Promise<{ labelsAdded: string[]; reviewers: string[] }> {
  const req = ReviewRequestSchema.parse(input);
  const [pull, login] = await Promise.all([
    gh.getPullRequest(req.repo, req.pr),
    gh.getAuthenticatedLogin(),
  ]);
  if (login.toLowerCase() === pull.author.toLowerCase()) {
    const passed = findPassedSelfReview(await gh.listComments(req.repo, req.pr), pull.author, pull.headSha);
    if (!passed) {
      throw new Error(`Peer review request refused: pull request author ${pull.author} has not recorded a successful Self-review at ${pull.headSha}.`);
    }
  }
  const labels = composeRequestLabels(req.skills);
  await gh.addLabels(req.repo, req.pr, labels);
  await gh.requestReviewers(req.repo, req.pr, req.reviewers);
  if (req.note) {
    await gh.createComment(req.repo, req.pr, `Agent review requested (${req.skills.join(", ") || "default"}): ${req.note}`);
  }
  return { labelsAdded: labels, reviewers: req.reviewers };
}
