import type { GitHubGateway } from "../github.js";
import type { Config, ReviewTask, Role } from "../model.js";
import { parseSkills } from "../labels.js";
import { serializeMarker, parseMarkers } from "../claim-marker.js";
import { composeInstructions, composeLanguages, hasSkill, loadSkill } from "../skills.js";
import { detectLanguages } from "../languages.js";
import { gatherRepoContext } from "../repo-context.js";

export async function claimReview(
  deps: { gh: GitHubGateway; config: Config; machine: string; now: string },
  opts: { repo: string; pr: number },
): Promise<ReviewTask> {
  const { gh, config, machine, now } = deps;
  const login = config.githubLogin ?? (await gh.getAuthenticatedLogin());
  const pr = await gh.getPullRequest(opts.repo, opts.pr);
  if (pr.state !== "open") throw new Error(`PR ${opts.repo}#${opts.pr} is ${pr.state}, not open`);

  let markers = parseMarkers(await gh.listComments(opts.repo, opts.pr));
  const own = markers.filter((m) => m.marker.reviewer === login).at(-1);
  let pinnedSha: string;
  if (own) {
    pinnedSha = own.marker.sha; // resume our own claim
  } else {
    pinnedSha = pr.headSha;
    await gh.createComment(opts.repo, opts.pr, serializeMarker({ v: 1, reviewer: login, machine, sha: pinnedSha, claimedAt: now }));
    markers = parseMarkers(await gh.listComments(opts.repo, opts.pr));
  }
  const earliest = [...markers].sort((a, b) =>
    a.marker.claimedAt.localeCompare(b.marker.claimedAt) || a.comment.id - b.comment.id)[0]?.marker;
  const role: Role = earliest && earliest.reviewer === login ? "anchor" : "enricher";

  const skills = parseSkills(pr.labels).filter((n) => n !== "second-opinion");
  const instructions = composeInstructions(skills, config);
  if (role === "enricher" && hasSkill("second-opinion", config)) {
    instructions.skills.push({ name: "second-opinion", content: loadSkill("second-opinion", config) });
  }

  let languages: string[] = [];
  try { languages = detectLanguages(await gh.listPullFiles(opts.repo, opts.pr)); } catch { languages = []; }
  const instructionsWithLangs = { ...instructions, languages: composeLanguages(languages, config) };

  let repoContext: Array<{ path: string; content: string }> = [];
  try { repoContext = await gatherRepoContext(gh, opts.repo, pinnedSha); } catch { repoContext = []; }

  return {
    repo: opts.repo, pr: pr.number, url: pr.url, title: pr.title, author: pr.author,
    headSha: pinnedSha, baseSha: pr.baseSha, reviewer: login, role, skills,
    languages,
    instructions: instructionsWithLangs,
    repoContext,
    claim: { machine, claimedAt: now },
  };
}
