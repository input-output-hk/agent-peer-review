# Review convergence

Repeated reviews use stable finding IDs and a bounded history so they converge on root causes instead of discovering one more peripheral example on every commit. `review_claim` returns `reviewContractVersion: 1` and a `reviewHistory` summary with the prior reviewed SHAs, latest finding statuses, accepted risks, last verdict, changes-requested cycle count, and the required mode. Full historical review bodies are never injected into the task.

Every completion attests one exact state: local `HEAD`, the claim SHA, `reviewedSha`, and the remote PR head must agree, and the index and worktree must be clean. A mismatch rejects the write. `request-changes` additionally requires at least one structured finding that is confirmed, blocking, in scope, actionable, and severe enough to hold the merge.

## Initial review

Use one stable ID for one root cause, even when several inputs reproduce it:

```json
{
  "reviewedSha": "4d76c4a",
  "mode": "initial",
  "findings": [{
    "id": "shell-policy-parser",
    "title": "The policy requires an unbounded shell interpreter",
    "severity": "high",
    "confidence": "confirmed",
    "scope": "introduced",
    "status": "open",
    "blocking": true,
    "path": "src/policy.ts",
    "line": 42,
    "evidence": "A bounded corpus reproduces wrapper, quoting, and command-substitution variants.",
    "remediation": "Narrow the policy or adopt an established parser.",
    "relatedFindingId": null
  }]
}
```

Further quoting forms stay evidence for `shell-policy-parser`; they do not become new findings or new review cycles.

## Re-review

First dispose every prior active ID. An approval may include a resolved original blocker and unrelated pre-existing cleanup as a non-blocking follow-up:

```json
{
  "reviewedSha": "901b80e",
  "mode": "rereview",
  "findings": [
    {
      "id": "shell-policy-parser",
      "title": "The policy requires an unbounded shell interpreter",
      "severity": "high",
      "confidence": "confirmed",
      "scope": "introduced",
      "status": "resolved",
      "blocking": false,
      "path": "src/policy.ts",
      "line": 42,
      "evidence": "The policy now accepts only direct executable names.",
      "remediation": "Resolved by the narrowed contract."
    },
    {
      "id": "legacy-cleanup",
      "title": "Pre-existing cleanup debt",
      "severity": "medium",
      "confidence": "high",
      "scope": "pre-existing",
      "status": "follow-up",
      "blocking": false,
      "path": "src/legacy.ts",
      "line": 18,
      "evidence": "The behavior predates and is unchanged by this pull request.",
      "remediation": "Track separately without withholding approval."
    }
  ]
}
```

## Convergence mode

After two changes-requested cycles, new adjacent medium or low hardening cannot block. Prior blockers, a regression caused by their fix, or a genuinely new critical/high PR-owned defect may still block:

```json
{
  "reviewedSha": "acf7081",
  "mode": "convergence",
  "findings": [{
    "id": "fix-regressed-isolation",
    "title": "The latest fix bypasses tenant isolation",
    "severity": "high",
    "confidence": "confirmed",
    "scope": "regression",
    "status": "regressed",
    "blocking": true,
    "path": "src/dispatch.ts",
    "line": 77,
    "evidence": "The new fallback routes tenant A's request through tenant B's cached context.",
    "remediation": "Keep the narrowed policy while preserving the tenant-keyed lookup."
  }]
}
```

## Design escalation and accepted safety decisions

Use a non-blocking comment when remediation is larger than the PR, a guard is turning into a parser, boundaries broaden, or no finite acceptance boundary can be stated. Do not repeatedly demand elapsed lock expiry, retries, force-release, or fallback when work cannot be cancelled and releasing its reservation could permit concurrent mutation. Record a defensible availability-versus-integrity trade-off as `accepted-risk`; reopening it requires new evidence.

When the current PR is safe, the author may create one meaningful review follow-up issue with `agent-review followup`, `review_followup`, or `pr_create_followup`. It must own specific finding IDs, explain why deferral is proportionate, and state concrete acceptance criteria. The reviewer may then mark the finding `follow-up`, include the issue URL, and approve with that issue taken into account. A second issue is refused, and an issue can never hide an unresolved blocker.

## Self-review before handoff

An implementing agent fixes every issue found by its own pass and repeats until the pass succeeds. It then records a current-head comment titled `Self-review`, explaining what changed, how it was fixed and verified, and why it is ready. Every author-owned request surface refuses to write a peer request until that authenticated exact-head marker exists; `pr_request_review` represents the hold as `self-review-required`, while direct CLI/MCP/Pi create calls fail with the same explanation.
