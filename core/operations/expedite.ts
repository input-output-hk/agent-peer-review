import type { GitHubGateway } from "../github.js";
import { classifyChange } from "../expedition/classify.js";
import { evaluateGates, type GateInput } from "../expedition/gate.js";
import { gatherRails, postProposal, resolveActingLogin } from "./expedition-shared.js";

export interface ExpediteInput {
  repo: string;
  pr: number;
  /** Defaults to the authenticated login. Supplying one that the token does not own throws. */
  actingLogin?: string;
  /** ISO timestamp supplied by the caller. This operation reads no clock. */
  now: string;
  /**
   * Defaults to "propose". An omitted autonomy is NEVER "auto": the caller has to ask for the
   * merge path explicitly, in writing, every time.
   */
  autonomy?: "auto" | "propose";
  policy?: { maxFiles?: number; maxLines?: number };
  mergeMethod?: "merge" | "squash" | "rebase";
  knownAgentLogins?: string[];
}

export interface ExpediteResult {
  action: "merged" | "proposed" | "already-proposed" | "not-eligible" | "blocked";
  /** The gate's reasons, in gate order, plus any cause the operation itself can name. Empty on a merge. */
  reasons: string[];
  headSha: string | null;
}

/**
 * Merge a trivial pull request, or explain in a comment why it will not be merged.
 *
 * The decision belongs entirely to evaluateGates (see gate.ts): this operation gathers the inputs,
 * hands them over, and does what it is told. In propose mode, the default, the only write is a
 * comment.
 *
 * Never throws for a policy outcome; every "no" is a status with reasons. Transport errors and a
 * borrowed actingLogin (see resolveActingLogin) propagate.
 */
export async function expedite(gh: GitHubGateway, input: ExpediteInput): Promise<ExpediteResult> {
  const { repo, pr } = input;
  const actingLogin = await resolveActingLogin(gh, input.actingLogin);

  const pull = await gh.getPullRequest(repo, pr);
  if (pull.state !== "open") {
    return { action: "not-eligible", reasons: [`the pull request is ${pull.state}, not open`], headSha: pull.headSha };
  }
  // H: the head every rail below is evaluated against, and the only SHA this operation will ever
  // pass to mergePull.
  const headSha = pull.headSha;

  const mergeability = await gh.getMergeability(repo, pr);
  // A draft never reaches the gate: GateInput.mergeableState has no "draft" member on purpose, so
  // the state is resolved here instead of being folded into some other value the gate would then
  // have to interpret.
  if (mergeability.draft || mergeability.state === "draft") {
    return { action: "not-eligible", reasons: ["the pull request is a draft"], headSha };
  }

  const files = await gh.listPullFilesDetailed(repo, pr);
  const classification = classifyChange(files.map((f) => f.filename));
  const rails = await gatherRails(gh, {
    repo, pr, headSha, author: pull.author, actingLogin,
    mergeability, files, knownAgentLogins: input.knownAgentLogins,
  });

  const gateInput: GateInput = {
    classification,
    changedFiles: rails.changedFiles,
    changedLines: rails.changedLines,
    checks: rails.checksSummary,
    // Assignable without a cast only because the draft short-circuit above narrowed "draft" out of
    // Mergeability["state"], which is precisely the member GateInput["mergeableState"] omits. If
    // that short-circuit is ever removed, this line stops compiling rather than quietly folding a
    // draft into some other state.
    mergeableState: mergeability.state,
    branchProtectionSatisfied: rails.branchProtectionSatisfied,
    hasNewSecurityAlert: rails.hasNewSecurityAlert,
    humanReviewPending: rails.humanReviewPending,
    humanChangesRequested: rails.humanChangesRequested,
    autonomy: input.autonomy ?? "propose",
    headShaGuardPassed: rails.headShaGuardPassed,
    actingLogin,
    author: pull.author,
    // Merging is not approving, so the self-approval rail does not apply here. It does in
    // approveDependencyUpgrade.
    isApproving: false,
    policy: input.policy,
  };
  const decision = evaluateGates(gateInput);
  // The gate owns the wording of each rail; where the operation knows something more specific than
  // the rail can express, it appends that cause rather than rewriting the rail's own reason.
  const reasons = rails.securityDetail !== null ? [...decision.reasons, rails.securityDetail] : [...decision.reasons];

  if (decision.action === "auto") {
    // A THROWN error here means the outcome is unknown, not that nothing happened: a write that is
    // retried can succeed on the server and still surface as an error. It is deliberately not
    // caught, so the flows above re-read the pull request's state before compensating rather than
    // assuming this merge did not land.
    const result = await gh.mergePull(repo, pr, { sha: headSha, method: input.mergeMethod ?? "merge" });
    if (!result.merged) {
      // reason distinguishes the two expected refusals: "head-moved" means re-evaluate at the new
      // head next tick, "not-mergeable" means the pull request itself has to change first.
      return { action: "blocked", reasons: [`merge refused (${result.reason ?? "unknown"}): ${result.message}`], headSha };
    }
    return { action: "merged", reasons, headSha };
  }

  const outcome = await postProposal(gh, {
    repo, pr, actingLogin, kind: "expedite-proposal", headSha, now: input.now,
    action: "merge this pull request",
    changeClasses: classification.categories,
    reasons,
  });
  return { action: outcome, reasons, headSha };
}
