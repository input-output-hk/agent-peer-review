---
sidebar_position: 2
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Quick start

This page installs the package, configures it, bootstraps labels on a repository, and walks through one full review from request to completion. Every command below is real: it is copied from `cli/index.ts`, not invented for the docs.

## Install

The package is published to GitHub Packages under the `@input-output-hk` scope, not to the public npm registry, so point npm at GitHub Packages first.

`~/.npmrc`:

```ini
@input-output-hk:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```bash
npm i -g @input-output-hk/agent-review
```

:::note
`GITHUB_TOKEN` needs at least `read:packages` to install. If you already export it for the review flow itself (see [Configure](#configure-optional) below), the same token can carry both scopes, so you do not need a second credential.
:::

Installing the package gives you two binaries: `agent-review` (the CLI) and `agent-review-mcp` (the MCP server; also reachable as `agent-review serve`).

## Guided setup

`agent-review init` does the rest of this page's setup (Configure, and Bootstrap labels below) in one step: it authenticates against GitHub, writes `~/.agent-peer-review/config.json`, bootstraps the `ai-review` label profile on every repo you give it, and prints an MCP config snippet plus the orchestration skill's location.

```bash
agent-review init --repo input-output-hk/some-repo
```

Run it without `--repo` from a terminal and it prompts for repositories, and optionally metadata capture, model, and agent, interactively. Pass `--repo` (repeatable) and `--yes` for non-interactive use, for example from an AI agent that already knows the repository name:

```bash
agent-review init --repo input-output-hk/some-repo --yes
```

See [`AGENTS.md`](https://github.com/input-output-hk/agent-peer-review/blob/main/AGENTS.md) at the repository root for the full install contract, written for an AI agent to follow end to end given just this repository's URL. The rest of this page explains what `init` automates, useful if you would rather configure by hand or drive one step at a time, for example re-running `labels bootstrap` alone after adding a skill to a repo that is already configured.

## Configure (optional)

Nothing below is required to get started. Your GitHub login is auto-detected from the token, and every command accepts an explicit `--repo`. A config file only saves typing.

`loadConfig` resolves the first file that exists, in this order:

1. an explicit path (the `-c, --config <path>` CLI flag),
2. the `AGENT_REVIEW_CONFIG` environment variable,
3. `~/.agent-peer-review/config.json` (or `$AGENT_PEER_REVIEW_HOME/config.json`),
4. `~/.config/agent-review/config.json` (legacy, still supported),
5. `.agent-review.json` in the current directory.

If none exist, every field falls back to its default. Since an MCP host has no `-c` flag to pass, `AGENT_REVIEW_CONFIG` is the way to point the MCP server at a specific file; the server reads it as its explicit path. See [Files and directories](./files-and-directories.md) for the full convention behind tier 3, including how the dashboard shares the same home directory.

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `githubLogin` | string or null | `null` | Your GitHub login. Leave it `null` and the first command that needs it resolves it once from the token via the GitHub API. |
| `defaultRepo` | string | none | An `owner/name` used whenever a command omits `--repo`. |
| `skillsDir` | string or null | `null` | Overrides the bundled `skills/` directory, useful while iterating on skill content locally. |
| `runChecks` | boolean | `false` | Whether the reviewing agent may run build or test scripts. Reviews stay read-only, diff-only analysis until you opt in. |
| `captureMetadata` | boolean | `false` | Opt in to a durable, machine-readable record of model/agent/verdict/role on every review. See [Review metadata capture](./metadata-capture.md) before enabling it, including its privacy note. |
| `model`, `agent`, `toolVersion` | string, optional | none | Only read when `captureMetadata` is on; see [Review metadata capture](./metadata-capture.md) for what each populates. |
| `reviewers` | array of string | `[]` | Default GitHub logins to request review from when a `request`/`review_create` call does not name any. See [Request a review](#request-a-review) below. |

`~/.agent-peer-review/config.json`:

```json
{ "githubLogin": null, "defaultRepo": "input-output-hk/some-repo", "skillsDir": null, "runChecks": false }
```

:::tip
Set `defaultRepo` once per machine and drop `--repo` from every command below. `--repo` always wins when both are present.
:::

Set a default reviewer (or several) so `agent-review request`, and the MCP/pi `review_create` tool, can omit `--reviewers`/`reviewers` entirely and still know who to ask:

```json
{ "reviewers": ["patextreme"] }
```

`agent-review init` accepts the same list via a repeatable flag:

```bash
agent-review init --repo input-output-hk/some-repo --reviewer patextreme
```

or override it for a single invocation, without touching the file, with the comma-separated `AGENT_REVIEW_REVIEWERS` environment variable:

```bash
AGENT_REVIEW_REVIEWERS=patextreme agent-review request --repo input-output-hk/some-repo --pr 42
```

:::tip
`reviewers` is only the default: an explicit `--reviewers` (CLI) or `reviewers` (MCP/pi) on a single call always wins over it, and `AGENT_REVIEW_REVIEWERS` wins over the config file the same way the other `AGENT_REVIEW_*` variables do (see [Review metadata capture](./metadata-capture.md#how-to-enable)). If nothing is set anywhere, `request`/`review_create` reports a clear error instead of silently requesting no one.
:::

## Bootstrap labels on a repository

Run this once per repository. It idempotently creates or updates the `ai-review` trigger label plus one label for every entry in `SKILL_NAMES`, and reports which labels were `created`, `updated`, or already `unchanged`.

```bash
agent-review labels bootstrap --repo input-output-hk/some-repo
```

## Request a review

Adds the `ai-review` label (plus any skill labels) and requests the review from one or more GitHub logins, using GitHub's native Reviewers field. `--reviewers` is optional if your config sets a default `reviewers` list (above); an explicit `--reviewers` always overrides the default for that one call.

```bash
agent-review request --repo input-output-hk/some-repo --pr 42 \
  --reviewers yshyn-iohk --skills security,cryptography --note "focus on the crypto changes"
```

## Wire into a host

The CLI, the MCP server, and the pi.dev Pi Package expose the same six operations over the same core, so pick whichever fits the host you run the reviewer agent on.

<Tabs>
<TabItem value="mcp" label="Claude Desktop / MCP hosts" default>

Point the host at the `serve` command so it can spawn the MCP server over stdio:

```json
{ "command": "npx", "args": ["-y", "@input-output-hk/agent-review", "serve"] }
```

The server exposes six tools (`review_create`, `review_list`, `review_claim`, `review_complete`, `review_enrich`, `labels_bootstrap`); see [MCP reference](./mcp.md) for their input fields.

</TabItem>
<TabItem value="pi" label="pi.dev">

Install the Pi Package so pi.dev loads the same six tools natively, plus a bundled `agent-review` skill that drives the loop:

```bash
pi install npm:@input-output-hk/agent-review-pi
```

See [pi.dev integration](./pi.md) for the tool list, the skill, and config. A CLI or MCP-adapter fallback is also available for pi.dev setups that cannot load the native extension.

</TabItem>
<TabItem value="cli" label="Codex / CLI hosts">

Install the `agent-review` binary where the agent can shell out to it, then load the `orchestration` skill (see [Skills](./skills.mdx)) so the agent knows the loop: list, then claim, then complete.

```bash
npm i -g @input-output-hk/agent-review
```

The orchestration skill is plain markdown; any host that can read a file and run a CLI can follow it, with no MCP support required.

</TabItem>
</Tabs>

## A first end-to-end example

Two roles are at play here: whoever requests the review, and the reviewer agent that fulfills it. They can be the same person on different days.

**1. The requester bootstraps labels once, then requests a review:**

```bash
agent-review labels bootstrap --repo input-output-hk/some-repo
agent-review request --repo input-output-hk/some-repo --pr 42 \
  --reviewers yshyn-iohk --skills security
```

**2. The reviewer agent lists its open work.** Run as `yshyn-iohk`, this returns pull request 42 with no active claim yet:

```bash
agent-review list --repo input-output-hk/some-repo
```

**3. It claims the pull request.** This pins the head commit SHA, posts a claim-marker comment, and returns the composed review instructions: the default `review` skill, the `security` skill content since it was requested, the `rust` language skill auto-detected from the pull request's changed `.rs` files, and any repo context found in the reviewed repository (`AGENT.md`, `.claude/**`, and similar). See [Languages](./languages.md) for how detection works.

```bash
agent-review claim --repo input-output-hk/some-repo --pr 42
```

**4. It reviews the diff at the pinned SHA** using the returned instructions, then writes its findings to two files:

```bash
cat > summary.md <<'EOF'
Two blocking issues; see inline comments.
EOF

cat > comments.json <<'EOF'
[{ "path": "src/crypto.rs", "line": 88, "body": "Nonce is reused across messages." }]
EOF
```

**5. It completes the review**, publishing a native GitHub PR review at the pinned SHA:

```bash
agent-review complete --repo input-output-hk/some-repo --pr 42 \
  --event request-changes --summary @summary.md --comments @comments.json
```

Submitting the review clears GitHub's review request automatically, and the claim marker is deleted. The pull request only reappears in `agent-review list` if someone requests the review again.

Continue to [Lifecycle](./lifecycle.md) to see exactly what happens at each of these steps, including restarts and commit drift.
