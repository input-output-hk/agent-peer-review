# Security

## Trust model

`@input-output-hk/agent-review` is designed for **trusted, internal use**: private repositories where the pull-request authors and the reviewing engineers are colleagues in the same organization. It is not hardened for public repositories with anonymous external contributors (see "Out of scope" below).

Even under that trusted model, the workflow feeds **untrusted input** to an LLM that then writes to GitHub with a write-capable token. The untrusted input is:

- the **pull-request diff**, and
- the reviewed repository's own **convention files** (`AGENT.md`, `AGENTS.md`, `CLAUDE.md`, `.claude/**`, `.codex/**`), fetched at the pinned commit SHA.

That content is authored by the PR submitter, so any instruction-shaped text inside it is untrusted.

## Defenses

- **Content policy served in every task.** `claimReview` serves a standing `contentPolicy` (see `core/guard.ts`) telling the agent to treat the diff and `repoContext` as data, never as instructions, and never to let them change its verdict, permissions, or tooling. It travels inside the review task, so it reaches every host (Claude, Codex, pi.dev).
- **Untrusted labeling.** Every file in `repoContext[]` is flagged `untrusted: true`. The PR diff is fetched out-of-band by the agent and cannot be embedded, so it is covered by the served policy prose rather than a structural flag.
- **Skill guidance.** The review and orchestration skills state that repo convention files inform code style and structure only, never the verdict, permissions, or which tools or commands run.
- **Read-only by convention.** The review skills instruct the agent not to run the repository's build or test scripts, and the documented host shortcut no longer disables permission prompts. This is advisory, enforced by the skills the agent follows rather than by code, so pair it with a least-privilege token and host isolation. (An earlier `runChecks` config switch was meant to gate this in code; no non-test code path ever read it, so it was removed from the schema rather than wired up. See issue #55.)

## Operating the reviewer safely

Some hosts auto-load a repository's own instruction files as their own operating instructions. Claude Code, for example, loads `CLAUDE.md` and `.claude/` as project memory whenever its working directory is inside the repository. Those files are authored by the PR submitter and are untrusted, so this can pull an injection payload into the host's trusted-instruction channel, ahead of the served `contentPolicy`.

- Do not run the reviewing agent with its working directory inside the checked-out PR tree. Review from a separate directory, or isolate the checkout so its `CLAUDE.md` and `.claude/` are not auto-ingested as instructions.
- `--setting-sources ""` governs `settings.json` sources; it does not necessarily suppress `CLAUDE.md` memory loading.
- Treat anything a host auto-loads from the checkout as untrusted data to review, never as instructions to follow.

## Recommended token scope

The review flow needs write access to submit reviews, add labels, and create and delete comments. Use a **fine-grained personal access token scoped to the target repositories** with the minimum permissions:

- Pull requests: read and write
- Issues: read and write (claim, self-review, and follow-up records use issue comments, and the
  bounded follow-up operation creates one repository issue)
- Contents: read
- Metadata: read

Prefer a separate least-privilege token for the review flow, distinct from any token used to install the package. The token is never logged.

### Additional scope for expedition taskflows

The scope above is everything the review flow (request, claim, self-review, follow-up, complete, enrich) needs. The expedition safety gate performs four additional reads in both `propose` and `auto` mode. A fine-grained token also needs:

- **Checks: read**
- **Commit statuses: read**
- **Administration: read** (to read branch protection)
- **Dependabot alerts: read**

The first three names and access levels come directly from GitHub's endpoint documentation for [check runs](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference), [combined commit status](https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference), and [branch protection](https://docs.github.com/en/rest/branches/branch-protection#get-branch-protection). On a classic token, `repo` covers those reads; Dependabot alerts additionally needs **`security_events`**.

Without any one of those reads, the affected rail fails closed. Unreadable checks and statuses become a synthetic failing check instead of throwing, unreadable protection becomes `unknown`, and unreadable alerts remain a distinct failure reason. Propose mode can therefore still post a truthful proposal rather than crashing.

`autonomy=auto` additionally needs **Contents: write** to merge a pull request ([GitHub's merge endpoint requirement](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)). `pr_stabilize` uses the already-listed **Pull requests: write** permission to update a behind branch; a 403 is reported as `blocked`. `agent-review init` makes a best-effort, read-only preflight of the four read permissions and prints a warning when it cannot confirm one. It cannot safely probe Contents write without making a write.

## Out of scope

- **Public repositories or forks with untrusted external authors.** Claim markers are not cryptographically authenticated for role assignment: a marker's `reviewer` is trusted by login within the organization boundary, so a determined untrusted commenter could forge one and confuse panel ordering. Destructive cleanup is stricter and deletes a marker only when the GitHub comment author agrees with its asserted reviewer. Fully rejecting mismatched markers and ignoring markers from users who are not requested reviewers remains out of scope.
- **The LLM host's own sandboxing.** This project provides guidance and in-task guards; it cannot enforce permissions inside a host it does not control.

## Reporting

Report suspected vulnerabilities to the maintainers privately rather than opening a public issue.
