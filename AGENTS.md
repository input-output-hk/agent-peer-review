# AGENTS.md

Install and configure contract for `agent-review`. This page is written for an AI coding agent
given this repository's URL, but a human can follow it too. Every command below is real.

## What this is

An asynchronous AI-agent PR-review workflow over GitHub: a CLI (primary), an MCP server
(secondary), and a skill, all over one shared core. GitHub is the source of truth (a trigger
label, native review requests, and native PR reviews); there is no external queue or database to
run.

## Prerequisites

- Node.js >= 22.
- A GitHub token, either exported as `GITHUB_TOKEN` or available via `gh auth login` (the CLI
  falls back to `gh auth token` when `GITHUB_TOKEN` is unset).
  - To **install** the package: a token with `read:packages`, since it is published to GitHub
    Packages, not the public npm registry.
  - To **run** the review workflow: a fine-grained personal access token scoped to the target
    repositories with Pull requests (read and write), Issues (read and write, since claim markers
    are issue comments), Contents (read), and Metadata (read). See
    [`SECURITY.md`](SECURITY.md#recommended-token-scope) for the full rationale. Prefer a separate
    least-privilege token for the review flow, distinct from the install token, though the same
    token can carry both sets of scopes if that is simpler.

## Install

```bash
cat >> ~/.npmrc <<'EOF'
@input-output-hk:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
EOF
npm i -g @input-output-hk/agent-review
npm i -g @input-output-hk/agent-review-pi   # only if the host is pi.dev
```

This installs two binaries: `agent-review` (the CLI) and `agent-review-mcp` (the MCP server, also
reachable as `agent-review serve`).

## Configure

```bash
agent-review init --repo owner/name [--repo owner/other] \
  [--capture-metadata] [--model <m>] [--agent <a>] [--tool-version <v>] --yes
```

- `--yes` (or any non-interactive stdin) is the path an AI agent should use: pass `--repo` at
  least once, or the command exits with guidance rather than hanging on a prompt.
- Run without `--yes` and without `--repo` from a terminal and `init` instead prompts for
  repositories (and optionally metadata capture, model, and agent) interactively; this is the
  human path.
- `init` authenticates against GitHub, writes `~/.agent-peer-review/config.json` (containing only
  the keys you passed), bootstraps the `ai-review` trigger label plus the skill labels on every
  `--repo`, and prints the config path written, the labels created or left unchanged per repo, a
  ready-to-paste MCP config snippet, and the orchestration skill's location.

## Surfaces

- **CLI**: `agent-review <command>`, including `init`, `labels bootstrap`, `request`, `list`,
  `claim`, `complete`, `enrich`, `config`, `whoami`, `skills list`, and `serve`. See
  [`docs/cli.md`](docs/cli.md).
- **MCP server**: `agent-review-mcp`. `init` prints the exact block to paste into an MCP host's
  config:
  ```json
  { "mcpServers": { "agent-review": { "command": "agent-review-mcp", "env": { "GITHUB_TOKEN": "..." } } } }
  ```
  See [`docs/mcp.md`](docs/mcp.md) for the six exposed tools.
- **Skill**: `skills/orchestration.md` (printed as an absolute path by `init`). It drives the
  claim -> review -> complete loop for Claude Code, Codex, and pi.dev. See
  [`docs/skills.mdx`](docs/skills.mdx) and [`docs/pi.md`](docs/pi.md) for how each host enables it.
- **Expedition taskflows** (pi.dev only, optional): three scheduled sweeps that go looking for work
  instead of reacting to a request, plus five `pr_*` tools they call. Set up separately, see below.

## Expedition taskflows (optional)

Only if the user wants the scheduled sweeps: `pr-requester` (their own open pull requests),
`pr-reviewer` (reviews requested from them, and pull requests they are already watching), and
`pr-steward` (bot dependency upgrades). Everything they can do is **propose-only** by default: the
agent posts one comment explaining what it would do, and changes nothing else.

1. Install the engine explicitly, it is an optional peer dependency and is not installed for you:
   `pi install npm:pi-taskflow` (needs Node.js 22.19.0 or newer).
2. Copy a flow into the target repository at `.pi/taskflows/<name>/`. The templates ship inside the
   installed package under `@input-output-hk/agent-review-pi/taskflows/`. Paths inside each flow
   definition are repository-relative and already point at `.pi/taskflows/<name>/`, so copy the
   whole directory and nothing needs editing.
3. Rename that flow's `config.example.json` to `config.json` and list the repositories to sweep.
4. Make sure the per-repository setup is in place: labels bootstrapped on every repository swept,
   `reviewers` set in `~/.agent-peer-review/config.json` (`pr_request_review` errors without it),
   and `knownAgentLogins` listing the peer agents. That last one is the easy thing to miss: any
   login not listed counts as a human, so an unlisted peer agent's review makes the safety gate
   hold for a human who was never involved.
5. Run one with `/tf:<name>` in a Pi host, or the `taskflow` MCP tool with `action: "run"`. There is
   no scheduler; recurrence is an external cron or a host-side loop.

**Never enable `autonomy=auto` on the user's behalf.** It is a per-invocation argument, it defaults
to `propose`, no config file can turn it up, and the open questions that gate it are tracked in
issue #39. Merging or approving on someone's repository is their decision to make explicitly.
See [`docs/taskflows.md`](docs/taskflows.md).

## What to confirm with the user

Before running `init`, or requesting a review, on someone's behalf, confirm:

1. **Which repositories** to bootstrap (`owner/name`, one or more).
2. **Whether to enable metadata capture** (`--capture-metadata`). It is opt-in and off by default.
   Turning it on makes `model`, `agent`, and the reviewing machine's hostname part of the
   **public** review body and claim marker on every review going forward. See
   [`docs/metadata-capture.md`](docs/metadata-capture.md#privacy) before enabling it.
3. **Which surface(s)** the user actually wants: the CLI directly, the MCP server wired into a
   host, and/or the orchestration skill, since `init` sets up all three but the user may only need
   one.
