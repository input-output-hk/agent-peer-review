import type { GitHubGateway } from "../github.js";
import type { ChangeClassification } from "../expedition/classify.js";
import { evaluateGates, type GateInput } from "../expedition/gate.js";
import { classifyDependencyUpgrade } from "../expedition/dep-upgrade.js";
import { gatherRails, postProposal, resolveActingLogin } from "./expedition-shared.js";

// The bots whose dependency pull requests this operation will look at. An allowlist, not a
// heuristic: "looks like a bot" is not a security boundary, and every entry here is additionally
// confirmed against GitHub's own actor type below.
export const DEFAULT_BOT_ALLOWLIST = ["dependabot[bot]", "renovate[bot]"] as const;

export interface ApproveDependencyUpgradeInput {
  repo: string;
  pr: number;
  /** Defaults to the authenticated login. Supplying one that the token does not own throws. */
  actingLogin?: string;
  /** ISO timestamp supplied by the caller. This operation reads no clock. */
  now: string;
  botAllowlist?: string[];
  /** Defaults to "propose". An omitted autonomy is NEVER "auto". */
  autonomy?: "auto" | "propose";
  policy?: { maxFiles?: number; maxLines?: number };
  mergeMethod?: "merge" | "squash" | "rebase";
  knownAgentLogins?: string[];
}

export interface ApproveDependencyUpgradeResult {
  action: "approved-and-merged" | "proposed" | "already-proposed" | "not-eligible" | "blocked";
  reasons: string[];
}

/**
 * Approve and merge a bot-authored dependency bump, or explain in a comment why it will not be.
 *
 * Three things have to hold before the safety gate is even consulted: the author is an allowlisted
 * bot AND GitHub agrees it is a Bot account, the diff is nothing but lockfiles and version-only
 * manifest edits, and the semver jump is patch or minor. Everything else, including a major bump
 * and anything this operation cannot read, goes to a human.
 *
 * Never throws for a policy outcome; every "no" is a status with reasons. Transport errors and a
 * borrowed actingLogin (see resolveActingLogin) propagate.
 */
export async function approveDependencyUpgrade(
  gh: GitHubGateway,
  input: ApproveDependencyUpgradeInput,
): Promise<ApproveDependencyUpgradeResult> {
  const { repo, pr } = input;
  const actingLogin = await resolveActingLogin(gh, input.actingLogin);
  const allowlist = input.botAllowlist ?? [...DEFAULT_BOT_ALLOWLIST];

  const pull = await gh.getPullRequest(repo, pr);
  if (pull.state !== "open") {
    return { action: "not-eligible", reasons: [`the pull request is ${pull.state}, not open`] };
  }
  const headSha = pull.headSha;

  if (!allowlist.includes(pull.author)) {
    return { action: "not-eligible", reasons: [`author "${pull.author}" is not an allowlisted dependency bot (${allowlist.join(", ")})`] };
  }
  // The allowlist is a list of names, and a name can be taken by a human account. Confirming the
  // actor type with GitHub is what makes the allowlist mean "that bot" rather than "that string".
  const actorType = await gh.getActorType(pull.author);
  if (actorType !== "Bot") {
    return { action: "not-eligible", reasons: [`author "${pull.author}" is a ${actorType} account, not a Bot`] };
  }

  const mergeability = await gh.getMergeability(repo, pr);
  if (mergeability.draft || mergeability.state === "draft") {
    return { action: "not-eligible", reasons: ["the pull request is a draft"] };
  }

  const files = await gh.listPullFilesDetailed(repo, pr);
  const dep = classifyDependencyUpgrade(files);
  if (!dep.eligibleShape) {
    return {
      action: "not-eligible",
      reasons: [`not a version-only dependency change: ${dep.ineligibleFiles.join(", ") || "the diff is empty"}`],
    };
  }
  if (dep.semverLevel === "major" || dep.semverLevel === "unknown") {
    // "unknown" covers a prerelease or otherwise unparseable version, and a lockfile-only diff,
    // which carries no readable version at all. Both are handed to a human rather than guessed at.
    return { action: "not-eligible", reasons: [`semver level is ${dep.semverLevel}; only patch and minor bumps take this path`] };
  }

  const rails = await gatherRails(gh, {
    repo, pr, headSha, author: pull.author, actingLogin,
    mergeability, files, knownAgentLogins: input.knownAgentLogins,
  });

  // The one sanctioned substitution of a content check for the path check. classifyChange
  // deliberately calls package.json "source", because a path cannot tell a version bump from a
  // scripts edit, so the path rule alone would reject every dependency pull request that touches a
  // manifest. classifyDependencyUpgrade answers what the path cannot, and it is STRICTER than the
  // path rule it replaces: it requires that every changed line in every manifest be a paired -/+
  // dependency version line, on top of the same lockfile allowlist classify.ts uses. Reaching this
  // point means that check passed, so the synthetic classification below states what has actually
  // been verified rather than what the path implies.
  const classification: ChangeClassification = {
    categories: ["deps"],
    autoEligible: true,
    sawSourceOrTest: false,
    byFile: files.map((f) => ({ file: f.filename, category: "deps" as const })),
  };

  const gateInput: GateInput = {
    classification,
    changedFiles: rails.changedFiles,
    changedLines: rails.changedLines,
    checks: rails.checksSummary,
    // Assignable only because the draft short-circuit above narrowed "draft" out of the union; see
    // the same note in expedite.ts.
    mergeableState: mergeability.state,
    branchProtectionSatisfied: rails.branchProtectionSatisfied,
    hasNewSecurityAlert: rails.hasNewSecurityAlert,
    humanReviewInFlight: rails.humanReviewInFlight,
    autonomy: input.autonomy ?? "propose",
    headShaGuardPassed: rails.headShaGuardPassed,
    actingLogin,
    author: pull.author,
    // This path really does approve, so the self-approval rail is live. It passes here because the
    // author is a bot and the acting agent is not that bot.
    isApproving: true,
    policy: input.policy,
  };
  const decision = evaluateGates(gateInput);
  const reasons = rails.securityDetail !== null ? [...decision.reasons, rails.securityDetail] : [...decision.reasons];
  const bumps = dep.changedPackages.map((p) => `\`${p.name}\`: ${p.from} -> ${p.to}`);

  if (decision.action === "auto") {
    // Approving is idempotent per head: a tick whose merge was refused (say the pull request went
    // briefly unmergeable) re-runs everything above, and the standing approval at this exact commit
    // must not turn into a second one.
    const alreadyApproved = rails.reviews.some((r) => r.author === actingLogin && r.state === "APPROVED" && r.commitId === headSha);
    if (!alreadyApproved) {
      const summary = `Automated ${dep.semverLevel} dependency upgrade by ${pull.author}, verified as version-only changes to ${dep.manifests.length > 0 ? dep.manifests.join(", ") : "lockfiles"}.`;
      await gh.submitReview(repo, pr, { commitId: headSha, event: "APPROVE", body: summary });
    }
    // As in expedite: a THROWN error here means the outcome is unknown, not that nothing happened.
    // It propagates so the flows above re-read the pull request's state instead of assuming the
    // merge did not land.
    const result = await gh.mergePull(repo, pr, { sha: headSha, method: input.mergeMethod ?? "merge" });
    if (!result.merged) {
      return { action: "blocked", reasons: [`merge refused (${result.reason ?? "unknown"}): ${result.message}`] };
    }
    return { action: "approved-and-merged", reasons };
  }

  const outcome = await postProposal(gh, {
    repo, pr, actingLogin, kind: "dep-upgrade-proposal", headSha, now: input.now,
    action: `approve and merge this ${dep.semverLevel} dependency upgrade`,
    changeClasses: classification.categories,
    reasons,
    details: [`Semver level: ${dep.semverLevel}`, ...bumps],
  });
  return { action: outcome, reasons };
}
