# Changelog

Notable changes to `@input-output-hk/agent-review` and `@input-output-hk/agent-review-pi`. The two packages are versioned in lockstep.

## Unreleased

### Steward role: an agent can now approve a bot dependency pull request it is qualified to approve
- Gate rails 5 and 4 no longer block the operation that supplies the approval. On a repository that requires an approving review the missing review failed both of them, for the same one reason: rail 5 compares the standing approvals against the required count, and GitHub's own `mergeStateStatus` reads `blocked` for exactly as long as a required review is outstanding, which failed rail 4. `protectionSatisfied` gained `pendingApprovalFromActor`, `GateInput` gained the same field for rail 4, and `gatherRails` gained `willApproveAs`, which grants the allowance only when the acting login is not the pull request's author and holds no standing approval (new `hasStandingApproval` keeps that judgement identical to `countApprovalsByOthers`, so one approval is never counted twice). Before this, the auto path was unreachable for `approveDependencyUpgrade` on exactly the repositories it is for, whose own approval was the missing requirement. Neither allowance is a bypass: rail 5 adds exactly one, so two required approvals with none present still holds the change back; rail 4 tolerates `blocked` alone and still refuses `dirty`, `unstable`, `behind`, and `unknown`, because approving would not change any of those; unreadable protection and required conversation resolution still fail closed; required checks must still be green; and a malformed count is still rejected before the increment applies. `expedite` merges rather than approves, passes no `willApproveAs`, and is unchanged on both rails.
- `approveDependencyUpgrade` re-reads every rail **after** approving and runs the whole gate a second time without either allowance, merging only if the second evaluation still returns `auto`. So a pull request GitHub still reports as `blocked` once the approval is in does not merge: it reports `approved`, and a later tick merges it once GitHub has recomputed the state. Re-running the gate rather than re-reading a chosen few rails is the point: approving is a write, and a human review, a red check, a new security alert, or a moved head arriving in that window each stop the merge, as does protection the approval turned out not to satisfy. A new `approved` result reports the approval landing without the merge, naming the rail that refused, since an approval is durable and unblocks the pull request for whoever merges it next. The approving review body now carries the verdict rather than a bare event: change class, semver level, the changed packages with old and new versions, the size, the head commit, and which rails passed. A review of this agent's own that a maintainer has DISMISSED at the current commit is a hard stop: re-approving would override an explicit human refusal that no other rail can see.
- A dependency-specific size policy, `DEPS_GATE_POLICY` (10 files, 4000 lines), is what `approveDependencyUpgrade` defaults to, per field and still overridable. What the larger cap rests on, stated plainly: manifest lines are read and verified to be nothing but paired dependency version edits, lockfile content is not read at all, and those lines are trusted on the authorship rail instead (an allowlisted dependency bot GitHub confirms is a Bot, regenerating a lockfile from the verified manifest edit). At the old 200-line cap a full lockfile regeneration went to a human and at 4000 it does not; a line count was never evidence about lockfile content either way. The file-count cap and every other rail are unchanged. `pr_approve_dep_upgrade` now exposes `maxFiles` and `maxLines`, clamped to that policy the same tighten-only way `pr_expedite` clamps to `DEFAULT_GATE_POLICY`.
- `requestPeerReview` refuses a pull request authored by one of the dependency bots the steward path accepts (`DEFAULT_BOT_ALLOWLIST`, overridable) with a new `bot-authored` status, and writes nothing at all, no label and no request. GitHub only forbids approving your own pull request, so an agent may review and approve such a change itself, and handing a machine-checkable dependency bump to another engineer's agent adds a round trip and a person's queue for no gain. Membership uses the same comparison the steward uses, so a pull request cannot be refused by one and declined by the other; confirmation that a listed name really is a bot comes from GitHub's actor type or the name shapes a bot carries (`name[bot]`, `app/name`), and an unreadable actor type is treated as "not a bot" rather than failing the call. Any other bot is still requestable, which matters: a codegen or release bot's source changes are exactly what a peer review is for. `pr_request_review` surfaces the status, and the `pr-requester` flow reports it and stops. The `pr-steward` flow's default `botAuthors` list gained `app/renovate` alongside `app/dependabot`, so the bots the tool accepts are the bots the flow discovers.
- The test gateway's unseeded mergeable state is now `unknown` (a state that fails the gate) rather than `clean`. That one default let tests seed branch protection requiring an approving review and still be handed a clean mergeable state, a combination GitHub cannot produce, which is how the rail 4 deadlock survived two review passes: the tests asserted an impossible world and passed. A test that cares about the mergeable state now has to say which one it means, and a merged pull request stops reporting `clean` even when `clean` was seeded.
- All of it stays **propose-only by default**: none of these paths is reachable without an explicit `autonomy: "auto"` on that individual call, and no configuration file can supply it. Addresses [#48](https://github.com/input-output-hk/agent-peer-review/issues/48) and items 1 and 2 of [#39](https://github.com/input-output-hk/agent-peer-review/issues/39).

## 0.5.0

### Expedition taskflows
- Five new core operations, exported from `@input-output-hk/agent-review`, that act on a pull request instead of reviewing one: `stabilize` (sync a branch with its base, reporting `up-to-date`, `updated`, `conflict`, `blocked`, `draft`, or `gone`), `expedite`, `requestPeerReview`, `approveDependencyUpgrade`, and `watchAndReReview`. With them: the central safety gate (`evaluateGates`, `DEFAULT_GATE_POLICY`), the path-based change classifier (`classifyChange`), the dependency-upgrade classifier, and the action-marker helpers (`buildActionMarker`, `findActionMarkers`) that keep a proposal comment idempotent per head commit. The gateway grew the reads and writes these need: mergeability, check runs, branch protection, detailed pull files, requested reviewers, actor type, and the open security-alert count, plus `updateBranch`, `mergePull`, `removeLabel`, and `addAssignees`. Every one of them is propose-only unless the caller passes `autonomy: "auto"` on that individual call.
- Five new pi tools that move a pull request forward instead of reviewing one: `pr_stabilize` (sync a branch with its base), `pr_expedite` (evaluate the expedition gate, then propose or merge), `pr_request_review` (request an agent peer review, once per round), `pr_approve_dep_upgrade` (evaluate a bot dependency upgrade, then propose or approve and merge), and `pr_watch` (decide the reviewer's next action: `re-review`, `wait`, `hold-for-human`, `abandoned`, `approved`, or `none`). The two that can merge take an explicit `autonomy` parameter that defaults to `propose` and is never read from the config file, and their optional `maxFiles`/`maxLines` can only tighten the default size caps, never widen them.
- Three taskflows ship with the pi package under `taskflows/`: `pr-requester` (my own open pull requests), `pr-reviewer` (reviews requested from me, plus the pull requests I am watching), and `pr-steward` (bot dependency upgrades). Each one is a zero-token discover script, a bounded fan-out over the typed tools, and a zero-token summary. Copy a flow into a repository's `.pi/taskflows/`, list the repositories in its `config.json`, and run it with `/tf:<name>`. This repository dogfoods all three from its own `.pi/taskflows/`.
- Propose-only is the default everywhere and it lives in the flow argument, not in configuration: `autonomy` defaults to `propose`, and no config file the flows read can turn it up. Auto therefore takes a visible per-invocation opt-in (`/tf:pr-steward autonomy=auto`). Every flow bounds its fan-out at four concurrent pull requests.
- A `knownAgentLogins` array in the global config (`~/.agent-peer-review/config.json`), also settable with the comma-separated `AGENT_REVIEW_KNOWN_AGENTS` environment variable, names the logins that count as agents rather than humans when the safety gate asks whether a human review is in flight. Empty by default, which is the safe end: an unlisted reviewer is always assumed to be a human.
- `pi-taskflow` is an optional peer dependency of `@input-output-hk/agent-review-pi`, so it is not installed for you. The flows need it explicitly (`pi install npm:pi-taskflow`), and it requires Node.js 22.19.0 or newer. See `docs/taskflows.md`.

### Security and dependencies
- Cleared every fixable open Dependabot alert. `@fastify/static` moved to 10.1.3 and `vite` to 6.4.3 in the dashboard (which also clears `esbuild`), the docs site picked up patched `mermaid`, `js-yaml`, `nanoid`, and `dompurify`, and the `undici` transitives reached 8.9.0. The last one needed the `@earendil-works/pi-coding-agent` development dependency raised to 0.84.1: that package publishes its own `npm-shrinkwrap.json`, which pins its subtree and silently defeats a root `overrides` entry. Neither published package changed a runtime dependency, and the peer floor stayed at 0.83.0 so consumer compatibility is unchanged. Two `image-size` advisories in the documentation site's transitive tree remain open because no patched version exists upstream; they affect the docs build only, which reads this repository's own images.

### Release process
- On-demand releases from `main`. A one-click `Release` workflow (from the Actions tab) bumps the version across every workspace with a single semver-aware script, finalizes this changelog, commits to `main`, and creates the GitHub release, which the existing publish workflow ships. A new `check:version` CI gate keeps the version consistent across all files, and `npm run version:set <patch|minor|major>` performs the bump locally. See `docs/releasing.md`.

### Dashboard
- The local, unpublished `dashboard` package gained its full UI: the Overview, Repos, repo Pulls, and Pull detail views, a hand-rolled client router with a light and dark theme toggle, and sanitized rendering of review summaries and inline notes. Build it with `npm run -w dashboard build` and serve it with `agent-review-dashboard serve`.
- Two aggregate views and the endpoints behind them: **Agents** (one row per captured agent and model identity, with its review count, primary and second-opinion split, verdict distribution, agreement breakdown, average turnaround, and repository count, plus a single "Unknown" row for reviews with no captured metadata) and **Collaborators** (one row per pull request author, with the reviews and verdicts their pull requests received and how many distinct agent identities reviewed them). Both are filterable by repository, served read-only from `/api/agents` and `/api/collaborators`. Verdict counts exclude reviews that recorded no verdict, so the views show raw counts rather than shares of a total, and the agreement column states that it is derived from posted second opinions rather than an authenticated signal. Semantic `--success` and `--warning` theme tokens join `--danger` so a good, a bad, and an ordinary value never share the brand red.

## 0.4.0

### Configurable reviewers
- A `reviewers` array in the global config (`~/.agent-peer-review/config.json`) names the default reviewer logins a review request targets when a call does not name any. Also settable via the `AGENT_REVIEW_REVIEWERS` environment variable (comma-separated) or `agent-review init --reviewer <login...>` (repeatable). The CLI `request` command, the MCP `review_create` tool, and the pi `review_create` tool all fall back to the configured default, and report a clear error when no reviewers are configured or passed. An explicit reviewers list on the call still wins over the config default.

### Dashboard
- The local, unpublished `dashboard` package gained its UI foundation: a Vite/React scaffold, the IOG theme, a typed API client, sanitized markdown rendering, and hand-rolled charts. The views themselves follow in a later release.

## 0.3.0

### Installation
- A new `agent-review init` guided setup command: authenticates against GitHub, writes `~/.agent-peer-review/config.json`, bootstraps the `ai-review` label profile on one or more repos, and prints a ready-to-paste MCP config snippet plus the orchestration skill's location. Accepts `--repo` (repeatable), `--capture-metadata`, `--model`, `--agent`, `--tool-version`, and `--yes` for non-interactive use (for example, from an AI agent); falls back to interactive prompts when run from a terminal without `--repo`.
- A new `AGENTS.md` at the repository root: a short, imperative install contract so an AI agent given the repo URL can install, authenticate, and configure the tool on its own.

### Review metadata capture
- Opt-in, durable review metadata capture (`captureMetadata` config field, default off). When enabled, `complete` and `enrich` append a hidden, machine-readable footer to the review body, and the claim marker moves to a v2 shape that carries `model`, `agent`, and `toolVersion` alongside the existing fields. The footer records `role`, `verdict`, `machine`, `claimedAt`, and whether the review posted after the head commit drifted. Off by default, so the workflow is unchanged unless you opt in.

### Discovery
- `findAgentPulls` enumerates every pull request the `ai-review` workflow has touched, across open, closed, and merged states, not only the open ones `list` sees. This is what backs the dashboard's `sync`.
- `PullRequest` now carries `createdAt`, `updatedAt`, and `mergedAt` timestamps.

### Configuration
- A new `~/.agent-peer-review/` home directory holds per-user global config and state, overridable with `AGENT_PEER_REVIEW_HOME`. `<home>/config.json` is now the preferred config file location; the legacy `~/.config/agent-review/config.json` and `./.agent-review.json` locations keep working.
- Fixed an env-override bug where an environment variable that was set but empty (for example, a host that always exports it and leaves it blank) clobbered a config file value instead of falling through to it.

### Breaking change
- The trigger label was renamed from `agent` to `ai-review`. Re-label any existing pull requests that still carry the old label, and re-run `agent-review labels bootstrap` on every repository using the workflow.

### Requirements
- Raised the minimum supported Node.js version to 22.

### Dashboard
- A local, unpublished `dashboard` package now ships in the repo: a `sync` command mirrors agent-reviewed pull requests into a local SQLite database, and a `serve` command exposes that database as a read-only, localhost-only HTTP API and UI. See the docs for details.

## 0.2.0

First published release: an asynchronous AI-agent PR-review workflow over GitHub, usable from the CLI, an MCP server, and a pi.dev extension.

### Core workflow
- All state lives on the pull request: an `ai-review` trigger label, native requested-reviewers for routing, a claim-marker comment that pins the head commit SHA, and a native PR review as the completion signal. No external queue, database, or long-running server.
- A pure `core` library behind a `GitHubGateway` port, with thin CLI, MCP, and pi.dev adapters over one code path.
- Idempotent label bootstrap for the orthogonal label profile.

### Panel review
- Multiple requested reviewers run as a concurrent panel: the earliest to claim is the anchor and posts the single primary review; later claimants are enrichers that add one consolidated second opinion once the primary lands. Stale-anchor promotion cascades without deadlock, and a competing primary is guarded so exactly one primary is posted per round in normal operation.

### Review context
- On claim, the task carries auto-detected per-language checklists, deepened domain skills (security and OWASP, cryptography, architecture), and the reviewed repository's own agent context (`AGENT.md`, `CLAUDE.md`, `.claude`, `.codex`). All best-effort and bounded, and never able to fail a claim.

### pi.dev
- `@input-output-hk/agent-review-pi`: a native pi.dev extension registering the six review tools plus a skill, distributed as a Pi Package.

### Security
- Untrusted review context (the diff and the reviewed repo's own files) is fenced and labeled, with a served content policy that travels to every host. See `SECURITY.md` and ADR 0007.
- Linear claim-marker parsing (no polynomial backtracking) and a least-privilege CI token.

### Distribution
- Published to GitHub Packages. See the ADRs under `docs/adr/` for the load-bearing design decisions.
