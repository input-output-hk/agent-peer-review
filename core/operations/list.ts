import type { GitHubGateway } from "../github.js";
import type { ReviewSummary } from "../model.js";
import { parseSkills } from "../labels.js";
import { parseMarkers, sortMarkers } from "../claim-marker.js";

export async function listReviews(
  gh: GitHubGateway,
  opts: { repo: string; login?: string },
): Promise<ReviewSummary[]> {
  const login = opts.login ?? (await gh.getAuthenticatedLogin());
  const prs = await gh.listReviewRequests(opts.repo, login);
  const rows: ReviewSummary[] = [];
  for (const pr of prs) {
    const active = sortMarkers(parseMarkers(await gh.listComments(opts.repo, pr.number)))[0]?.marker;
    rows.push({
      repo: opts.repo, pr: pr.number, url: pr.url, title: pr.title,
      skills: parseSkills(pr.labels), headSha: pr.headSha, claim: active,
    });
  }
  return rows;
}
