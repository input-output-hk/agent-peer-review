import type { GitHubGateway } from "../github.js";

export interface StabilizeResult {
  /**
   * `gone` and `blocked` are deliberately separate, and callers must not conflate them.
   *
   * `gone` means the pull request is closed or merged: there is nothing left to do with it, ever.
   * `blocked` means the pull request is OPEN and healthy enough to work on, but its mergeable state
   * is one syncing cannot change ("blocked", "unstable", "unknown"). On a protected repository
   * "blocked" is the everyday state of a pull request whose required review has not been submitted
   * yet, so a caller that treats it as terminal would abandon precisely the pull requests that need
   * a review requested.
   */
  status: "up-to-date" | "updated" | "conflict" | "blocked" | "draft" | "gone";
  detail: string;
}

/**
 * Bring a pull request's branch back in sync with its base, and report what stands in the way if
 * it cannot be done.
 *
 * The only mutation this operation can make is `updateBranch` (merging the base INTO the pull
 * request's branch). It never merges, approves, labels, or comments. Syncing a branch with its own
 * base is the one write sanctioned in v1's propose-only mode: it changes nothing about the pull
 * request's content or its review state, and it is what a maintainer would do by hand before
 * looking again.
 *
 * Never throws for a policy outcome: every state the branch can be in maps to a status. Transport
 * errors from the gateway propagate.
 */
export async function stabilize(gh: GitHubGateway, input: { repo: string; pr: number }): Promise<StabilizeResult> {
  const { repo, pr } = input;

  // Read the pull request's own state first. This is the one operation here that can write without
  // first consulting the gate, so it owes the same "is this pull request still live" check the
  // gate-consuming operations make: a closed or merged pull request must never be pushed to.
  const pull = await gh.getPullRequest(repo, pr);
  if (pull.state !== "open") {
    return { status: "gone", detail: `the pull request is ${pull.state}, not open; there is nothing to sync` };
  }

  const mergeability = await gh.getMergeability(repo, pr);

  // Both signals are honored: GitHub reports a draft through the `draft` flag and, usually, a
  // "draft" mergeable_state. A draft is the author's own "not ready" marker, so nothing is done to
  // it, not even a base sync.
  if (mergeability.draft || mergeability.state === "draft") {
    return { status: "draft", detail: "the pull request is a draft; the author has not marked it ready for review" };
  }

  switch (mergeability.state) {
    case "clean":
      return { status: "up-to-date", detail: "the branch is up to date with its base and mergeable" };
    case "behind": {
      // `expectedHeadSha` is the head read from getMergeability in this same tick, so a push that
      // lands between the read and the write is rejected by GitHub rather than silently rebuilt on
      // top of a commit this operation never saw.
      const result = await gh.updateBranch(repo, pr, mergeability.headSha);
      if (result === "updated") {
        return { status: "updated", detail: `the branch was behind ${mergeability.baseRef} and has been updated` };
      }
      if (result === "forbidden") {
        return { status: "blocked", detail: `the branch is behind ${mergeability.baseRef}, but this token is not allowed to update it` };
      }
      return { status: "conflict", detail: `the branch could not be updated from ${mergeability.baseRef}: conflict, or the head moved during the update` };
    }
    case "dirty":
      return { status: "conflict", detail: `the branch has merge conflicts with ${mergeability.baseRef} that only the author can resolve` };
    default:
      // "blocked" (a required review or check is missing), "unstable" (a non-required check is
      // failing), and "unknown" (GitHub has not finished computing mergeability yet). None of them
      // is a sync problem, so syncing would not help, and none of them means the pull request is
      // finished: all three describe an OPEN pull request that still wants attention. A closed or
      // merged pull request never reaches here; it returned "gone" above.
      return { status: "blocked", detail: `mergeable state is ${mergeability.state}; stabilize cannot change that` };
  }
}
