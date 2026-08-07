// Rolls a ref's raw check results up into the single "green" | "pending" | "failing" value the
// safety gate takes (see gate.ts, rail 3). Pure: no I/O, no clock, no randomness.
//
// Conservative by default: the only way to reach "green" is for every judged result to have
// reported a non-failing conclusion. Anything that has not reported yet holds the rollup at
// "pending", which the gate treats as a hard stop, so a check that is merely slow can never be
// mistaken for a check that passed.

import type { CheckResult } from "../github.js";

export type ChecksSummary = "green" | "pending" | "failing";

/**
 * Summarize check results for one ref.
 *
 * With a non-empty `requiredContexts` (branch protection's required status checks) ONLY those
 * contexts are judged: an unrelated optional check that is red or still running does not block a
 * merge the repository's own rules would allow. A required context with no matching result is
 * "pending", never green: it has not reported, and absence of a report is not a pass.
 *
 * With no required contexts every result is judged instead, which is the honest reading of an
 * unprotected branch: there is no declared subset, so all of the evidence counts. An empty result
 * list then yields "green", because a repository that runs no checks at all has nothing that can
 * fail; the remaining rails (branch protection, human review in flight, size caps) are what keep
 * such a repository from auto-merging on nothing.
 *
 * `neutral` (GitHub's neutral/skipped conclusions) counts as success, matching GitHub's own
 * treatment of a skipped required check as satisfied.
 */
export function summarizeChecks(checks: CheckResult[], requiredContexts?: string[]): ChecksSummary {
  const judged: CheckResult["status"][] = [];
  if (requiredContexts && requiredContexts.length > 0) {
    for (const context of requiredContexts) {
      // A context can legitimately produce more than one result (a check run and a commit status
      // sharing a name); every one of them is judged, so the worst outcome wins.
      const matches = checks.filter((c) => c.name === context);
      if (matches.length === 0) { judged.push("pending"); continue; }
      for (const m of matches) judged.push(m.status);
    }
  } else {
    for (const c of checks) judged.push(c.status);
  }
  if (judged.some((s) => s === "failure")) return "failing";
  if (judged.some((s) => s === "pending")) return "pending";
  return "green";
}
