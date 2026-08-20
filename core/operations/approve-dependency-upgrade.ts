import type { GitHubGateway } from "../github.js";
import type { ChangeClassification } from "../expedition/classify.js";
import { evaluateGates, DEPS_GATE_POLICY, type GateInput } from "../expedition/gate.js";
import { classifyDependencyUpgrade } from "../expedition/dep-upgrade.js";
import { gatherRails, postProposal, resolveActingLogin } from "./expedition-shared.js";

// The bots whose dependency pull requests this operation will look at. An allowlist, not a
// heuristic: "looks like a bot" is not a security boundary, and every entry here is additionally
// confirmed against GitHub's own actor type below.
export const DEFAULT_BOT_ALLOWLIST = ["dependabot[bot]", "renovate[bot]"] as const;

// At most this many package bumps are spelled out in the approving review body; the rest are
// counted. The body is read by a human, and a bot upgrade sweeping a whole transitive tree would
// otherwise bury the verdict under a list nobody reads.
const MAX_LISTED_PACKAGES = 10;

/**
 * The body of the approving review: the verdict, not just the event.
 *
 * A bare "APPROVED" with no text leaves the pull request's history unable to answer what was
 * approved or on what grounds. This body states the class of change, the semver level, the packages,
 * the size, the commit it applies to, and which rails were satisfied, so the audit trail is a review
 * a human can read and disagree with.
 */
function renderApprovalBody(input: {
  author: string;
  semverLevel: "patch" | "minor";
  bumps: string[];
  manifests: string[];
  changedFiles: number;
  changedLines: number;
  maxFiles: number;
  maxLines: number;
  headSha: string;
}): string {
  const listed = input.bumps.slice(0, MAX_LISTED_PACKAGES);
  const remaining = input.bumps.length - listed.length;
  const packages = input.bumps.length === 0
    ? ["- no manifest version change to read (lockfiles only)"]
    : [...listed.map((bump) => `- ${bump}`), ...(remaining > 0 ? [`- and ${remaining} more`] : [])];

  return [
    "### Automated dependency approval",
    "",
    `This is an automated steward approval of a bot-authored dependency change, submitted by an agent rather than by a person. Every rail of the safety gate passed at \`${input.headSha}\`.`,
    "",
    `- Verdict: approve and merge this ${input.semverLevel} dependency upgrade`,
    "- Change class: deps",
    `- Semver level: ${input.semverLevel}`,
    `- Author: ${input.author} (confirmed a Bot account by GitHub)`,
    `- Size: ${input.changedFiles} file(s), ${input.changedLines} changed line(s), within the dependency policy of ${input.maxFiles} files and ${input.maxLines} lines`,
    `- Manifests: ${input.manifests.length > 0 ? input.manifests.join(", ") : "none (lockfiles only)"}`,
    `- Head commit: \`${input.headSha}\``,
    "",
    "Packages:",
    "",
    ...packages,
    "",
    "Rails that passed: the diff is a version-only dependency change (every changed manifest line is a paired dependency version edit, every other changed file a lockfile); it fits the dependency size policy; required checks are green; GitHub reports a clean mergeable state; branch protection is satisfied, counting this approval toward its required-approvals rule; the security-alert rail is clear; no human review is in flight; autonomy \"auto\" was passed explicitly on this call; the head has not moved since the evaluation; and the approving login is not the author.",
  ].join("\n");
}

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
  /**
   * Size caps for the gate's size rail. Each field defaults, independently, to DEPS_GATE_POLICY
   * rather than to the general DEFAULT_GATE_POLICY: a lockfile's line count is mechanical churn, not
   * reviewable surface (see DEPS_GATE_POLICY for the full reasoning). A caller may still pass either
   * field, and the pi tool that exposes them clamps both so a caller can only tighten them.
   */
  policy?: { maxFiles?: number; maxLines?: number };
  mergeMethod?: "merge" | "squash" | "rebase";
  knownAgentLogins?: string[];
}

export interface ApproveDependencyUpgradeResult {
  /**
   * - `approved-and-merged`: the approval was submitted and the pull request is in.
   * - `approved`: the approval was submitted (or already stood) and the merge was NOT performed.
   *   An approval is durable and independently useful, since it unblocks the pull request for
   *   whoever merges it next, so "we approved but could not merge" is neither nothing at all nor
   *   the same thing as a merge. `reasons` names what still blocks.
   * - `proposed` / `already-proposed`: the gate held the change back; the reasons are a comment.
   * - `not-eligible`: this path does not handle the change (closed, draft, non-bot author, not a
   *   version-only diff, a major or unreadable bump).
   * - `blocked`: a merge was refused and this agent has no approval standing on the pull request.
   */
  action: "approved-and-merged" | "approved" | "proposed" | "already-proposed" | "not-eligible" | "blocked";
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
 * On the auto path the approval comes first and the merge is judged separately, against state read
 * AFTER the approval landed: rail 5 counts the approval this operation is about to add (that is what
 * makes the decision to approve possible at all on a protected repository), and it would be a
 * different and wrong thing to let that same assumption authorize the merge. So an approval that
 * does not actually satisfy protection reports `approved` and stops, rather than merging on the
 * strength of its own arithmetic.
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

  // willApproveAs is what tells the protection check that the approval it is looking for is the one
  // this call is about to submit. Without it rail 5 is unsatisfiable here (issue #48): the required
  // approval cannot be present before the operation whose whole job is to add it has run.
  const rails = await gatherRails(gh, {
    repo, pr, headSha, author: pull.author, actingLogin,
    mergeability, files, knownAgentLogins: input.knownAgentLogins,
    willApproveAs: actingLogin,
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

  // Per field, not per object: a caller that tightens one cap must not silently inherit the general
  // 200-line default for the other.
  const policy = {
    maxFiles: input.policy?.maxFiles ?? DEPS_GATE_POLICY.maxFiles,
    maxLines: input.policy?.maxLines ?? DEPS_GATE_POLICY.maxLines,
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
    policy,
  };
  const decision = evaluateGates(gateInput);
  const reasons = rails.securityDetail !== null ? [...decision.reasons, rails.securityDetail] : [...decision.reasons];
  const bumps = dep.changedPackages.map((p) => `\`${p.name}\`: ${p.from} -> ${p.to}`);

  if (decision.action === "auto") {
    // Approving is idempotent per head: a tick whose merge was refused (say the pull request went
    // briefly unmergeable) re-runs everything above, and the standing approval at this exact commit
    // must not turn into a second one.
    //
    // Note this is a HEAD-specific question, unlike rails.actorHasStandingApproval: protection
    // counts a standing approval whatever commit it was left on, but an approval left on a commit
    // the bot has since force-pushed past does not state a verdict on the diff being merged now, so
    // a moved head earns a fresh one.
    const alreadyApproved = rails.reviews.some((r) => r.author === actingLogin && r.state === "APPROVED" && r.commitId === headSha);
    // Tracked rather than assumed: every outcome below has to say whether an approval of ours is
    // standing on the pull request, and the two ways it gets there (submitted now, or submitted on
    // an earlier tick at this same head) must not be reported differently.
    let approvalStands = alreadyApproved;
    if (!alreadyApproved) {
      await gh.submitReview(repo, pr, {
        commitId: headSha,
        event: "APPROVE",
        body: renderApprovalBody({
          author: pull.author,
          semverLevel: dep.semverLevel,
          bumps,
          manifests: dep.manifests,
          changedFiles: rails.changedFiles,
          changedLines: rails.changedLines,
          maxFiles: policy.maxFiles,
          maxLines: policy.maxLines,
          headSha,
        }),
      });
      // The write is durable and independently useful: it unblocks the pull request for whoever
      // merges it next, so from here on a refused merge is "approved", not "nothing happened".
      approvalStands = true;
    }

    // Re-read before merging, WITHOUT willApproveAs. The rails above counted the approval this
    // operation was about to add, which is what makes the decision to approve possible on a
    // protected repository, and it would be a different claim entirely to let that same arithmetic
    // authorize the merge. So protection, mergeability, and the checks are read again and judged as
    // they now really are: if GitHub does not agree that protection is satisfied once the approval
    // is in (a second required approval, a required check that is not green yet), this stops.
    const afterMergeability = await gh.getMergeability(repo, pr);
    const after = await gatherRails(gh, {
      repo, pr, headSha, author: pull.author, actingLogin,
      mergeability: afterMergeability, files, knownAgentLogins: input.knownAgentLogins,
    });

    const blockers: string[] = [];
    if (!after.branchProtectionSatisfied) {
      blockers.push("branch protection still not satisfied after approving; a required check or a second approval is outstanding");
    }
    if (afterMergeability.draft || afterMergeability.state !== "clean") {
      blockers.push(`mergeable state is ${afterMergeability.draft ? "draft" : afterMergeability.state} (need clean) after approving`);
    }
    if (!after.headShaGuardPassed) {
      blockers.push("the head moved after the approval; the next tick re-evaluates the new commit");
    }
    if (blockers.length > 0) {
      return { action: approvalStands ? "approved" : "blocked", reasons: blockers };
    }

    // As in expedite: a THROWN error here means the outcome is unknown, not that nothing happened.
    // It propagates so the flows above re-read the pull request's state instead of assuming the
    // merge did not land.
    const result = await gh.mergePull(repo, pr, { sha: headSha, method: input.mergeMethod ?? "merge" });
    if (!result.merged) {
      // reason distinguishes the two expected refusals exactly as before; only the status changed,
      // because the approval landed either way and reporting "blocked" would hide it.
      const refusal = `merge refused (${result.reason ?? "unknown"}): ${result.message}`;
      return { action: approvalStands ? "approved" : "blocked", reasons: [refusal] };
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
