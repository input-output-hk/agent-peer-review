# Changelog

Notable changes to `@input-output-hk/agent-review` and `@input-output-hk/agent-review-pi`. The two packages are versioned in lockstep.

## Unreleased

### Expedition taskflows
- Five new pi tools that move a pull request forward instead of reviewing one: `pr_stabilize` (sync a branch with its base), `pr_expedite` (evaluate the expedition gate, then propose or merge), `pr_request_review` (request an agent peer review, once per round), `pr_approve_dep_upgrade` (evaluate a bot dependency upgrade, then propose or approve and merge), and `pr_watch` (decide the reviewer's next action: `re-review`, `wait`, `hold-for-human`, `abandoned`, `approved`, or `none`). The two that can merge take an explicit `autonomy` parameter that defaults to `propose` and is never read from the config file, and their optional `maxFiles`/`maxLines` can only tighten the default size caps, never widen them.
- Three taskflows ship with the pi package under `taskflows/`: `pr-requester` (my own open pull requests), `pr-reviewer` (reviews requested from me, plus the pull requests I am watching), and `pr-steward` (bot dependency upgrades). Each one is a zero-token discover script, a bounded fan-out over the typed tools, and a zero-token summary. Copy a flow into a repository's `.pi/taskflows/`, list the repositories in its `config.json`, and run it with `/tf:<name>`. This repository dogfoods all three from its own `.pi/taskflows/`.
- Propose-only is the default everywhere and it lives in the flow argument, not in configuration: `autonomy` defaults to `propose`, and no config file the flows read can turn it up. Auto therefore takes a visible per-invocation opt-in (`/tf:pr-steward autonomy=auto`). Every flow bounds its fan-out at four concurrent pull requests.
- A `knownAgentLogins` array in the global config (`~/.agent-peer-review/config.json`), also settable with the comma-separated `AGENT_REVIEW_KNOWN_AGENTS` environment variable, names the logins that count as agents rather than humans when the safety gate asks whether a human review is in flight. Empty by default, which is the safe end: an unlisted reviewer is always assumed to be a human.
- `pi-taskflow` is an optional peer dependency of `@input-output-hk/agent-review-pi`, so it is not installed for you. The flows need it explicitly (`pi install npm:pi-taskflow`), and it requires Node.js 22.19.0 or newer. See `docs/taskflows.md`.

### Release process
- On-demand releases from `main`. A one-click `Release` workflow (from the Actions tab) bumps the version across every workspace with a single semver-aware script, finalizes this changelog, commits to `main`, and creates the GitHub release, which the existing publish workflow ships. A new `check:version` CI gate keeps the version consistent across all files, and `npm run version:set <patch|minor|major>` performs the bump locally. See `docs/releasing.md`.

### Dashboard
- The local, unpublished `dashboard` package gained its full UI: the Overview, Repos, repo Pulls, and Pull detail views, a hand-rolled client router with a light and dark theme toggle, and sanitized rendering of review summaries and inline notes. Build it with `npm run -w dashboard build` and serve it with `agent-review-dashboard serve`.

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
