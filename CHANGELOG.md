# Changelog

Notable changes to `@input-output-hk/agent-review` and `@input-output-hk/agent-review-pi`. The two packages are versioned in lockstep.

## 0.2.0

First published release: an asynchronous AI-agent PR-review workflow over GitHub, usable from the CLI, an MCP server, and a pi.dev extension.

### Core workflow
- All state lives on the pull request: an `agent` trigger label, native requested-reviewers for routing, a claim-marker comment that pins the head commit SHA, and a native PR review as the completion signal. No external queue, database, or long-running server.
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
