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

  const markers = sortMarkers(parseMarkers(await gh.listComments(opts.repo, opts.pr)));
  // The marker body is attacker-controlled text. Delete only comments whose GitHub author agrees
  // with the asserted reviewer; a maintainer comment that merely claims reviewer=login must never
  // become deletable by this operation.
  const ours = markers.filter((m) => m.marker.reviewer === login && m.comment.author === login);
  const own = ours[0];
  let pinnedSha: string;
  // The marker set whose earliest claim decides the role. Re-read only when a marker of ours was
  // added to it, which a re-pin does not do: a re-pin replaces our own claim by the same reviewer at
  // the same claimedAt, so the ordering that answers "who claimed first" is exactly what it was.
  let ordered = markers;
  if (own && own.marker.sha === pr.headSha) {
    pinnedSha = own.marker.sha; // resume our own claim: the pin still describes the head
  } else if (own) {
    // Re-pin. A claim marker used to be a permanent SHA pin: this branch resumed whatever commit the
    // marker named and nothing ever moved it, so an agent whose run stalled re-claimed a dead commit
    // on every tick, reviewed code that no longer existed, and the drift that produced then read to
    // the watch path as an author push, manufacturing another round with no author action at all
    // (issue #52).
    //
    // Done as a delete followed by a post, which keeps the marker FORMAT untouched: every marker
    // already in the wild parses exactly as before, and the parse stays a single linear pass. In
    // that order, deliberately: posting first and then failing to delete would leave two markers of
    // ours, and the next tick would resume the stale one and re-pin again, which is a comment per
    // tick forever. Failing after the delete instead just loses the claim, and the next tick posts a
    // fresh one at the head, which is where this was heading anyway.
    //
    // Nothing but the sha changes. claimedAt in particular is carried over rather than set to `now`,
    // so a re-pin cannot reorder the panel and an anchor stays the anchor; the machine and any v2
    // metadata go on describing the claim that was made, which is still this same claim.
    pinnedSha = pr.headSha;
    // Every marker of ours, not just the one being re-pinned: a claim race can leave a duplicate, and
    // leaving one behind would put the stale pin back at the front of the queue on the next tick.
    for (const stale of ours) await gh.deleteComment(opts.repo, stale.comment.id);
    await gh.createComment(opts.repo, opts.pr, serializeMarker({ ...own.marker, sha: pinnedSha }));
  } else {
    pinnedSha = pr.headSha;
    // Metadata capture is opt-in (Config.captureMetadata, default false): off, this writes a v1
    // marker without the hostname; on, it writes a v2 marker carrying the machine plus
    // model/agent/toolVersion from config (JSON.stringify drops any unset optional fields).
    const marker: ClaimMarker = config.captureMetadata
      ? { v: 2, reviewer: login, machine, sha: pinnedSha, claimedAt: now, model: config.model, agent: config.agent, toolVersion: config.toolVersion }
      : { v: 1, reviewer: login, sha: pinnedSha, claimedAt: now };
    await gh.createComment(opts.repo, opts.pr, serializeMarker(marker));
    ordered = sortMarkers(parseMarkers(await gh.listComments(opts.repo, opts.pr)));
  }
  const earliest = ordered[0]?.marker;
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
