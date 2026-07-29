import type { GitHubGateway } from "../github.js";
import { ReviewRequestSchema, type ReviewRequest } from "../model.js";
import { composeRequestLabels } from "../labels.js";

export async function createReview(gh: GitHubGateway, input: ReviewRequest): Promise<{ labelsAdded: string[]; reviewers: string[] }> {
  const req = ReviewRequestSchema.parse(input);
  const labels = composeRequestLabels(req.skills);
  await gh.addLabels(req.repo, req.pr, labels);
  await gh.requestReviewers(req.repo, req.pr, req.reviewers);
  if (req.note) {
    await gh.createComment(req.repo, req.pr, `Agent review requested (${req.skills.join(", ") || "default"}): ${req.note}`);
  }
  return { labelsAdded: labels, reviewers: req.reviewers };
}
