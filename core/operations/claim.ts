import type { GitHubGateway } from "../github.js";
import type { Config, ReviewTask } from "../model.js";
import { parseSkills } from "../labels.js";
import { serializeMarker, parseMarkers } from "../claim-marker.js";
import { composeInstructions } from "../skills.js";

export async function claimReview(
  deps: { gh: GitHubGateway; config: Config; machine: string; now: string },
  opts: { repo: string; pr: number },
): Promise<ReviewTask> {
  const { gh, config, machine, now } = deps;
  const login = config.githubLogin ?? (await gh.getAuthenticatedLogin());
  const pr = await gh.getPullRequest(opts.repo, opts.pr);
  if (pr.state !== "open") throw new Error(`PR ${opts.repo}#${opts.pr} is ${pr.state}, not open`);

  const active = parseMarkers(await gh.listComments(opts.repo, opts.pr)).at(-1)?.marker;
  let pinnedSha: string;
  if (active) {
    if (active.reviewer !== login) throw new Error(`PR ${opts.repo}#${opts.pr} already claimed by ${active.reviewer} (${active.machine})`);
    pinnedSha = active.sha; // resume our own claim on the originally pinned SHA
  } else {
    pinnedSha = pr.headSha;
    await gh.createComment(opts.repo, opts.pr, serializeMarker({ v: 1, reviewer: login, machine, sha: pinnedSha, claimedAt: now }));
    // Re-read to resolve a same-login race: earliest marker (by claimedAt, then comment id) wins.
    const after = parseMarkers(await gh.listComments(opts.repo, opts.pr));
    const winner = after.sort((a, b) =>
      a.marker.claimedAt.localeCompare(b.marker.claimedAt) || a.comment.id - b.comment.id)[0]?.marker;
    if (winner && winner.machine !== machine) pinnedSha = winner.sha;
  }

  const skills = parseSkills(pr.labels);
  return {
    repo: opts.repo, pr: pr.number, url: pr.url, title: pr.title, author: pr.author,
    headSha: pinnedSha, baseSha: pr.baseSha, reviewer: login, skills,
    instructions: composeInstructions(skills, config), claim: { machine, claimedAt: now },
  };
}
