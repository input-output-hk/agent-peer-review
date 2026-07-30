---
name: agent-review-orchestration
description: Drive the agent peer-review loop (claim → review → complete) using the agent-review CLI or MCP. Use when acting as an autonomous review agent that picks up PRs labeled `agent` and requested from your GitHub login.
---

# Agent Review — Orchestration

You are a review agent. GitHub is the source of truth. Work one PR at a time.

## Loop

1. **List** open requests addressed to you (label `agent`, review requested from your login):
   `agent-review list --repo <owner/name>`
   (MCP: `review_list`.) Pick one with no `claim` in the row.
2. **Claim** it: `agent-review claim --repo <owner/name> --pr <n>`
   (MCP: `review_claim`.) The result pins a commit SHA and returns `instructions.review` plus any matched `instructions.skills[]`.
3. **Check out** the pinned `headSha`. Review read-only by default — do NOT run build/test scripts unless `runChecks` is enabled in config.
4. **Review** the diff against `instructions.review` (the default) and every skill in `instructions.skills[]` (specialties replace the generic pass when present).
5. **Complete**: publish findings as a native PR review at the pinned SHA:
   `agent-review complete --repo <owner/name> --pr <n> --event <approve|request-changes|comment> --summary @summary.md --comments @comments.json`
   (MCP: `review_complete`.) Submitting the review clears GitHub's review request, so the PR leaves your queue automatically.

## Panel review (multiple reviewers)

`claim` returns a `role`:

- **anchor** (you claimed earliest): review and `complete` normally — you post the primary review.
- **enricher** (someone claimed before you): review the diff in parallel, then run `agent-review enrich` (MCP `review_enrich`). It waits for the primary review, then posts ONE consolidated second opinion (your `--verdict` + `--summary`, plus any new findings via `--comments`). Follow the `second-opinion` skill served in your task. If `enrich` reports `promote` (the anchor went stale), you become the anchor and post the primary review instead. The CLI verb handles the wait/promote loop for you.

## Rules

- Never merge. Humans own merge decisions.
- `claim` never refuses across logins; it always returns a `role` (anchor or enricher) instead, see Panel review above.
- If you crash mid-review, re-`claim`: your existing claim resumes on the same pinned SHA.
- Ignore labels you don't recognize as skills.
