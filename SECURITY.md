# Security

## Trust model

`@input-output-hk/agent-review` is designed for **trusted, internal use**: private repositories where the pull-request authors and the reviewing engineers are colleagues in the same organization. It is not hardened for public repositories with anonymous external contributors (see "Out of scope" below).

Even under that trusted model, the workflow feeds **untrusted input** to an LLM that then writes to GitHub with a write-capable token. The untrusted input is:

- the **pull-request diff**, and
- the reviewed repository's own **convention files** (`AGENT.md`, `AGENTS.md`, `CLAUDE.md`, `.claude/**`, `.codex/**`), fetched at the pinned commit SHA.

That content is authored by the PR submitter, so any instruction-shaped text inside it is untrusted.

## Defenses

- **Content policy served in every task.** `claimReview` serves a standing `contentPolicy` (see `core/guard.ts`) telling the agent to treat the diff and `repoContext` as data, never as instructions, and never to let them change its verdict, permissions, or tooling. It travels inside the review task, so it reaches every host (Claude, Codex, pi.dev).
- **Untrusted labeling.** Every file in `repoContext[]` is flagged `untrusted: true`.
- **Skill guidance.** The review and orchestration skills state that repo convention files inform code style and structure only, never the verdict, permissions, or which tools or commands run.
- **Read-only by default.** The default review does not run the repository's build or test scripts unless the operator sets `runChecks`, and the documented host shortcut no longer disables permission prompts.

## Recommended token scope

The review flow needs write access to submit reviews, add labels, and create and delete comments. Use a **fine-grained personal access token scoped to the target repositories** with the minimum permissions:

- Pull requests: read and write
- Issues: read and write (claim markers are issue comments)
- Contents: read
- Metadata: read

Prefer a separate least-privilege token for the review flow, distinct from any token used to install the package. The token is never logged.

## Out of scope

- **Public repositories or forks with untrusted external authors.** Claim markers are not cryptographically authenticated: a marker's `reviewer` is trusted by login within the organization boundary, so a determined untrusted commenter could forge one. Hardening for that posture (rejecting markers whose comment author differs from the asserted reviewer, and ignoring markers from users who are not requested reviewers) is possible but not enabled by default.
- **The LLM host's own sandboxing.** This project provides guidance and in-task guards; it cannot enforce permissions inside a host it does not control.

## Reporting

Report suspected vulnerabilities to the maintainers privately rather than opening a public issue.
