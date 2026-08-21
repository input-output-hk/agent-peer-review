import type { GitHubGateway } from "../github.js";
import type { ChangeClassification } from "../expedition/classify.js";
import { evaluateGates, DEPS_GATE_POLICY, type GateInput } from "../expedition/gate.js";
import { classifyDependencyUpgrade } from "../expedition/dep-upgrade.js";
import { gatherRails, postProposal, resolveActingLogin } from "./expedition-shared.js";

// The bots whose dependency pull requests this operation will look at. An allowlist, not a
// heuristic: "looks like a bot" is not a security boundary, and a listed author has to be confirmed
// a bot on top of being listed (see confirmsBotAuthor).
//
// These are REST logins, which is what GitHub's pulls API reports (`user.login`). The same App shows
// up as `app/renovate` through GitHub's GraphQL API, which is what the `gh` CLI prints and therefore
// what a discover script matches on. Both spellings reach this package, so membership is decided on
// the folded identity below rather than on the string, and one entry covers both surfaces.
export const DEFAULT_BOT_ALLOWLIST = ["dependabot[bot]", "renovate[bot]"] as const;

// The two affixes a bot's name carries, and the only two. `[bot]` is the suffix GitHub gives a bot
// USER account; `app/` is the prefix GraphQL gives an App integration. Neither character set is
// legal in a human login, which is what makes either one evidence (see confirmsBotAuthor).
const APP_PREFIX = "app/";
const BOT_SUFFIX = "[bot]";

/**
 * The identity behind a bot's name, with the surface it arrived on folded away.
 *
 * One bot reaches this package under two different names: `pulls.get` reports `renovate[bot]` and
 * GraphQL reports `app/renovate`, for the same App. An allowlist written in one spelling therefore
 * refused every pull request that arrived in the other, on every tick, writing nothing (issue #50).
 * Folding both to `renovate` is what makes the allowlist a list of BOTS rather than of strings.
 *
 * The fold is: lowercase (neither shape is a name GitHub compares case-sensitively), then strip one
 * `app/` prefix and one `[bot]` suffix. A fold that would leave nothing behind (`app/`, `[bot]`,
 * `app/[bot]`) is not applied at all: a name that is only an affix identifies no bot, and two of
 * them must not compare equal to each other.
 *
 * Exported because it is the single definition every question below is answered from, so a name
 * shape can only ever be understood one way. A linear scan, no regex: the value comes straight from
 * a pull request.
 */
export function normalizeBotAuthor(author: string): string {
  const lower = author.toLowerCase();
  const start = lower.startsWith(APP_PREFIX) ? APP_PREFIX.length : 0;
  const end = lower.endsWith(BOT_SUFFIX) ? lower.length - BOT_SUFFIX.length : lower.length;
  return start < end ? lower.slice(start, end) : lower;
}

/**
 * Whether a name carries a marker only a bot can carry.
 *
 * Derived from the fold rather than restated, which is the point: this is true exactly when
 * normalizeBotAuthor removed an affix. Teaching the fold a third name shape teaches this at the
 * same time, so the two cannot drift apart the way they had (issue #50: the `app/` branch of the
 * previous copy of this check was unreachable dead code, because the allowlist comparison it sat
 * behind could never match an `app/` name in the first place).
 *
 * Not a security boundary on its own, and never used as one: see confirmsBotAuthor.
 */
function looksLikeBotAuthor(author: string): boolean {
  return normalizeBotAuthor(author) !== author.toLowerCase();
}

/**
 * Whether `author` is really a bot, given GitHub's own answer about the login.
 *
 * GitHub's answer wins whenever it has one: a login it reports as a User or an Organization is not
 * a bot, whatever the name looks like, so an allowlisted NAME taken by a human account cannot walk
 * into an automated path. The name shape is consulted only for "unknown", which is what the users
 * API returns for an App integration: `GET /users/app/renovate` is a 404, so requiring a positive
 * `Bot` there would refuse every `app/`-named author forever, which is the same deadlock one rail
 * further along. `[bot]` and `app/` are safe evidence in that gap because neither `[` nor `/` is
 * legal in a GitHub username, so no human account can present either shape.
 *
 * Exported so `requestPeerReview` asks this exact question. The two operations have to agree: a
 * pull request the requester refuses because "the steward owns it" and the steward then declines as
 * not-a-bot would get less attention than one nobody special-cased at all.
 */
export function confirmsBotAuthor(author: string, actorType: "User" | "Bot" | "Organization" | "unknown"): boolean {
  if (actorType === "Bot") return true;
  if (actorType !== "unknown") return false;
  return looksLikeBotAuthor(author);
}

/**
 * Whether `author` is one of the dependency bots this path handles.
 *
 * Exported so `requestPeerReview` can ask the SAME question with the same rule. The two have to
 * agree exactly, for the reason given on confirmsBotAuthor. Both sides of the comparison are folded,
 * so an allowlist may be written in either spelling and a caller never has to list a bot twice.
 */
export function isAllowlistedDependencyBot(author: string, allowlist: readonly string[]): boolean {
  const identity = normalizeBotAuthor(author);
  return allowlist.some((entry) => normalizeBotAuthor(entry) === identity);
}

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
  /**
   * How the author was confirmed to be a bot, in the body's own words. Stated rather than fixed:
   * for an `app/`-named App integration GitHub's users API resolves nothing at all, so a sentence
   * claiming GitHub confirmed the account would be false on exactly the pull requests issue #50 was
   * about.
   */
  authorConfirmation: string;
  semverLevel: "patch" | "minor";
  bumps: string[];
  manifests: string[];
  changedFiles: number;
  changedLines: number;
  maxFiles: number;
  maxLines: number;
  headSha: string;
  /** True only when this approval actually satisfied a required-approvals rule; see RailInputs. */
  pendingApprovalCounted: boolean;
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
    `- Author: ${input.author} (${input.authorConfirmation})`,
    `- Size: ${input.changedFiles} file(s), ${input.changedLines} changed line(s), within the dependency policy of ${input.maxFiles} files and ${input.maxLines} lines`,
    `- Manifests: ${input.manifests.length > 0 ? input.manifests.join(", ") : "none (lockfiles only)"}`,
    `- Head commit: \`${input.headSha}\``,
    "",
    "Packages:",
    "",
    ...packages,
    "",
    // The protection clause is conditional because the honest statement differs: on a branch with no
    // protection, or none that requires an approving review, this approval was counted toward
    // nothing at all, and a fixed sentence claiming otherwise would be false on most repositories.
    `Rails that passed: the diff is a version-only dependency change (every changed manifest line is a paired dependency version edit, every other changed file a lockfile); it fits the dependency size policy; required checks are green; GitHub reports a clean mergeable state; ${input.pendingApprovalCounted ? "branch protection is satisfied, counting this approval toward its required-approvals rule (the merge is judged separately, without it)" : "branch protection is satisfied"}; the security-alert rail is clear; no human review is pending and no human has requested changes; autonomy "auto" was passed explicitly on this call; the head has not moved since the evaluation; and the approving login is not the author.`,
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
   * rather than to the general DEFAULT_GATE_POLICY, because for this class of change the authorship
   * and content rails are what bound the risk and a lockfile's line count never was evidence either
   * way (see DEPS_GATE_POLICY, which states plainly what that trade gives up). A caller may still
   * pass either field, and the pi tool that exposes them clamps both so a caller can only tighten.
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
   *   Today's auto path cannot produce it: every exit below happens after an approval stands, so
   *   there is no code path to hunt for. It is kept as the fail-safe answer to "the merge failed and
   *   nothing was approved", so that a future branch which merges without approving reports that
   *   truthfully instead of claiming an approval it never made.
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

  // Folded, not compared literally: the same bot arrives as `renovate[bot]` from the pulls API and
  // as `app/renovate` from GraphQL, and refusing the second spelling refused it on every tick
  // forever (issue #50).
  if (!isAllowlistedDependencyBot(pull.author, allowlist)) {
    return { action: "not-eligible", reasons: [`author "${pull.author}" is not an allowlisted dependency bot (${allowlist.join(", ")})`] };
  }
  // The allowlist is a list of identities, and a name can be taken by a human account. Confirming
  // with GitHub is what makes the allowlist mean "that bot" rather than "that string".
  const actorType = await gh.getActorType(pull.author);
  if (!confirmsBotAuthor(pull.author, actorType)) {
    // Two different refusals, because they are two different facts. GitHub naming the author a User
    // or an Organization is a positive answer that the name shape may not override. "unknown" means
    // GitHub could not tell us at all, and the name carried no marker to fall back on.
    return {
      action: "not-eligible",
      reasons: [actorType === "unknown"
        ? `GitHub cannot resolve the author "${pull.author}", and the name carries no bot marker ("[bot]" or "app/") to confirm it with`
        : `author "${pull.author}" is a ${actorType} account, not a Bot`],
    };
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
    //
    // On a protected repository this is "blocked" until the required review exists, so rail 4 needs
    // the same pending-approval allowance rail 5 does or the deadlock simply moves one rail over.
    // Rail 4 honors it only alongside isApproving, and only for "blocked".
    mergeableState: mergeability.state,
    pendingApprovalFromActor: rails.pendingApprovalFromActor,
    branchProtectionSatisfied: rails.branchProtectionSatisfied,
    hasNewSecurityAlert: rails.hasNewSecurityAlert,
    humanReviewPending: rails.humanReviewPending,
    humanChangesRequested: rails.humanChangesRequested,
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

  // A DISMISSED review by this agent at THIS commit is a maintainer saying no to this exact approval,
  // in the loudest way GitHub offers. Nothing else can see it: dismissing creates no review by the
  // dismisser, so rail 7 finds no human in flight, and the dismissal clears the standing approval,
  // which would otherwise make this operation re-approve the very verdict a human just struck down.
  // So it is a hard stop on the auto path. Head-specific on purpose: once the bot force-pushes, the
  // dismissed verdict was about a different diff.
  const dismissedAtHead = rails.reviews.some((r) =>
    r.author.toLowerCase() === actingLogin.toLowerCase() && r.state === "DISMISSED" && r.commitId === headSha);

  const reasons = [
    ...decision.reasons,
    ...(dismissedAtHead ? ["this agent's own approval of this commit was dismissed; re-approving would override an explicit human refusal"] : []),
    ...(rails.securityDetail !== null ? [rails.securityDetail] : []),
  ];
  const bumps = dep.changedPackages.map((p) => `\`${p.name}\`: ${p.from} -> ${p.to}`);

  if (decision.action === "auto" && !dismissedAtHead) {
    // Approving is idempotent per head: a tick whose merge was refused (say the pull request went
    // briefly unmergeable) re-runs everything above, and the standing approval at this exact commit
    // must not turn into a second one.
    //
    // Two conditions, and both are needed. The standing verdict has to BE an approval that counts,
    // which is the same question rail 5 asked when it granted the pending approval, so the two cannot
    // disagree: an APPROVED row at this head followed by a CHANGES_REQUESTED at the same head leaves
    // rail 5 counting a pending approval that this guard would otherwise decide not to submit, and the
    // operation would then report "approved" on every tick forever while its own outstanding
    // CHANGES_REQUESTED kept the pull request blocked. And the approval has to be at THIS head, which
    // rail 5 now also requires of an approval it counts (see ApprovalScope) except on a branch that
    // dismisses stale reviews itself. On such a branch an approval left on an earlier commit can still
    // be counted, and it still states no verdict on the diff being merged now, so this stays a
    // separate condition rather than a restatement of the first.
    const alreadyApproved = rails.actorHasStandingApproval
      && rails.reviews.some((r) => r.author.toLowerCase() === actingLogin.toLowerCase() && r.state === "APPROVED" && r.commitId === headSha);
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
          authorConfirmation: actorType === "Bot"
            ? "confirmed a Bot account by GitHub"
            : 'a name only a bot can carry ("[bot]" or "app/"); GitHub\'s users API does not resolve it',
          semverLevel: dep.semverLevel,
          bumps,
          manifests: dep.manifests,
          changedFiles: rails.changedFiles,
          changedLines: rails.changedLines,
          maxFiles: policy.maxFiles,
          maxLines: policy.maxLines,
          headSha,
          pendingApprovalCounted: rails.pendingApprovalCounted,
        }),
      });
      // The write is durable and independently useful: it unblocks the pull request for whoever
      // merges it next, so from here on a refused merge is "approved", not "nothing happened".
      approvalStands = true;
    }

    // Re-read every rail before merging, WITHOUT willApproveAs. Two separate reasons, and both
    // matter:
    //
    //   1. The rails above counted the approval this operation was about to add, which is what makes
    //      the decision to APPROVE possible on a protected repository. Letting that same arithmetic
    //      authorize the MERGE would be a different claim entirely, so the +1 is dropped here and
    //      protection is judged as it now really is.
    //   2. Approving is a write, and writes take time. Anything can have changed in that window: a
    //      human can post CHANGES_REQUESTED or be asked to review, a security alert can appear, a
    //      check can go red, the head can move.
    //
    // So the decision is the GATE's again, on the after-state, rather than a hand-written list of
    // the rails someone thought worth re-checking. That is the point: a rail added to evaluateGates
    // later is re-checked here automatically, and the failure mode of forgetting one (a merge that
    // proceeds through a rail that has since flipped) cannot be reintroduced by omission.
    // isApproving is false because the remaining action is the merge, not an approval.
    const afterMergeability = await gh.getMergeability(repo, pr);
    const after = await gatherRails(gh, {
      repo, pr, headSha, author: pull.author, actingLogin,
      mergeability: afterMergeability, files, knownAgentLogins: input.knownAgentLogins,
    });

    // A draft is resolved here rather than folded into the gate, exactly as on the way in:
    // GateInput.mergeableState has no "draft" member, so this narrows it out first.
    const blockers: string[] = [];
    if (afterMergeability.draft || afterMergeability.state === "draft") {
      blockers.push("the pull request became a draft after the approval");
    } else {
      const afterDecision = evaluateGates({
        ...gateInput,
        changedFiles: after.changedFiles,
        changedLines: after.changedLines,
        checks: after.checksSummary,
        mergeableState: afterMergeability.state,
        branchProtectionSatisfied: after.branchProtectionSatisfied,
        hasNewSecurityAlert: after.hasNewSecurityAlert,
        humanReviewPending: after.humanReviewPending,
        humanChangesRequested: after.humanChangesRequested,
        headShaGuardPassed: after.headShaGuardPassed,
        isApproving: false,
        // Both allowances are off here, stated explicitly rather than left to follow from isApproving.
        // This is the evaluation that decides whether to MERGE, and neither rail 4 nor rail 5 may take
        // anything on credit any more: the approval has landed, so if protection is still unsatisfied
        // or GitHub still says "blocked", that is the real state and the merge does not happen. The
        // after-gather passes no willApproveAs, so `after.branchProtectionSatisfied` carries no +1.
        pendingApprovalFromActor: false,
      });
      if (afterDecision.action !== "auto") {
        blockers.push(...afterDecision.reasons, ...(after.securityDetail !== null ? [after.securityDetail] : []));
      }
    }
    if (blockers.length > 0) {
      // The leading line is what makes the rest readable: on its own, "branch protection requirements
      // are not satisfied" would look like the verdict that stopped an approval, when in fact the
      // approval is already in and this is what stopped the merge that followed it.
      return {
        action: approvalStands ? "approved" : "blocked",
        reasons: [`the approval stands at ${headSha}, but the merge did not happen: re-checking every rail after approving found`, ...blockers],
      };
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
