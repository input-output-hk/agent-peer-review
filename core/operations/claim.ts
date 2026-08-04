import type { GitHubGateway } from "../github.js";
import type { ClaimMarker, Config, ReviewTask, Role } from "../model.js";
import { parseSkills } from "../labels.js";
import { serializeMarker, parseMarkers, sortMarkers } from "../claim-marker.js";
import { composeInstructions, composeLanguages, hasSkill, loadSkill } from "../skills.js";
import { detectLanguages } from "../languages.js";
import { gatherRepoContext } from "../repo-context.js";
import { UNTRUSTED_CONTENT_POLICY } from "../guard.js";

export async function claimReview(
  deps: { gh: GitHubGateway; config: Config; machine: string; now: string },
  opts: { repo: string; pr: number },
): Promise<ReviewTask> {
  const { gh, config, machine, now } = deps;
  const login = config.githubLogin ?? (await gh.getAuthenticatedLogin());
  const pr = await gh.getPullRequest(opts.repo, opts.pr);
  if (pr.state !== "open") throw new Error(`PR ${opts.repo}#${opts.pr} is ${pr.state}, not open`);

  let markers = parseMarkers(await gh.listComments(opts.repo, opts.pr));
  const own = sortMarkers(markers).filter((m) => m.marker.reviewer === login)[0];
  let pinnedSha: string;
  if (own) {
    pinnedSha = own.marker.sha; // resume our own claim
  } else {
    pinnedSha = pr.headSha;
    // Metadata capture is opt-in (Config.captureMetadata, default false): off, this writes a v1
    // marker exactly as before; on, it writes a v2 marker carrying model/agent/toolVersion from
    // config (JSON.stringify in serializeMarker drops any that are unset).
    const marker: ClaimMarker = config.captureMetadata
      ? { v: 2, reviewer: login, machine, sha: pinnedSha, claimedAt: now, model: config.model, agent: config.agent, toolVersion: config.toolVersion }
      : { v: 1, reviewer: login, machine, sha: pinnedSha, claimedAt: now };
    await gh.createComment(opts.repo, opts.pr, serializeMarker(marker));
    markers = parseMarkers(await gh.listComments(opts.repo, opts.pr));
  }
  const earliest = sortMarkers(markers)[0]?.marker;
  const role: Role = earliest && earliest.reviewer === login ? "anchor" : "enricher";

  const skills = parseSkills(pr.labels).filter((n) => n !== "second-opinion");
  const instructions = composeInstructions(skills, config);
  if (role === "enricher" && hasSkill("second-opinion", config)) {
    instructions.skills.push({ name: "second-opinion", content: loadSkill("second-opinion", config) });
  }

  let languages: string[] = [];
  let languageSkills: Array<{ name: string; content: string }> = [];
  try {
    languages = detectLanguages(await gh.listPullFiles(opts.repo, opts.pr));
    languageSkills = composeLanguages(languages, config);
  } catch { languages = []; languageSkills = []; }
  const instructionsWithLangs = { ...instructions, languages: languageSkills };

  let repoContext: Array<{ path: string; content: string; untrusted: true }> = [];
  try { repoContext = await gatherRepoContext(gh, opts.repo, pinnedSha); } catch { repoContext = []; }

  return {
    repo: opts.repo, pr: pr.number, url: pr.url, title: pr.title, author: pr.author,
    headSha: pinnedSha, baseSha: pr.baseSha, reviewer: login, role, skills,
    languages,
    instructions: instructionsWithLangs,
    contentPolicy: UNTRUSTED_CONTENT_POLICY,
    repoContext,
    claim: { machine, claimedAt: now },
  };
}
