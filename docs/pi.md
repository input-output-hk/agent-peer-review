---
sidebar_position: 8
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# pi.dev integration

`@input-output-hk/agent-review-pi` is a Pi Package: a small TypeScript extension that registers the same six review operations as native tools inside [pi.dev](https://pi.dev) (`@earendil-works/pi-coding-agent`), plus an `agent-review` skill that drives the claim-review-complete loop. It is a thin adapter over the `@input-output-hk/agent-review` core, the same core the CLI and the MCP server use, so a Claude host, a Codex host, and a pi.dev host all see identical review instructions.

## Install

```bash
pi install npm:@input-output-hk/agent-review-pi
```

This registers the extension (the six tools below) and the bundled `agent-review` skill with your pi.dev host in one step. Point npm at GitHub Packages first, the same as for the core package (see [Quick start](./quick-start.md#install)):

```ini
@input-output-hk:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

## The six tools

Same operations, same core, same result shape as the [MCP reference](./mcp.md): every tool returns a single text content block holding pretty-printed JSON.

| Tool | Logical operation | Purpose |
| --- | --- | --- |
| `review_create` | `review.create` | Add the `ai-review` label plus any skill labels, and request the reviewer(s) natively. |
| `review_list` | `review.list` | List open, `ai-review`-labeled pull requests requested from a login (defaults to yours). |
| `review_claim` | `review.claim` | Pin the head SHA, post a claim marker, and return the composed review task. |
| `review_complete` | `review.complete` | Submit a PR review at the pinned SHA (which clears the request), then delete the claim marker. |
| `review_enrich` | `review.enrich` | Post a consolidated second opinion once the primary review exists; otherwise report `waiting` or `promote`. |
| `labels_bootstrap` | `labels.bootstrap` | Idempotently create or update the `ai-review` label plus every skill label. |

Input fields are identical to the [MCP reference's input fields](./mcp.md#input-fields); only the transport differs.

## The `agent-review` skill

The package bundles a Pi skill, `skills/agent-review/SKILL.md`, that describes the reviewer loop in terms of the tools above: list open requests, claim one (which pins a commit SHA and returns `instructions` plus auto-detected `languages` and `repoContext`), review the diff at the pinned SHA against everything the claim served, then finish as the anchor (`review_complete`) or as a second reviewer (`review_enrich`). It also reads the local checkout directly for repo-specific conventions, and never merges; humans own merge decisions. pi.dev loads the skill automatically once the package is installed, no extra configuration needed.

## Config

Same `Config` shape and resolution order as the CLI and the MCP server (see [Quick start](./quick-start.md#configure-optional)). `githubLogin` is auto-detected from your token when left `null`. The GitHub token itself resolves from the `GITHUB_TOKEN` environment variable first, then falls back to `gh auth token`, so a `gh auth login` on the machine running pi.dev is enough on its own. Set `AGENT_REVIEW_CONFIG` to point at a specific config file if the default resolution order would not find the one you want.

## Fallback routes

If a given pi.dev setup cannot load the native extension, two fallbacks reach the same workflow without it.

<Tabs>
<TabItem value="cli" label="CLI via the bash tool" default>

Install the `agent-review` binary where pi.dev's `bash` tool can reach it, then load the `orchestration` skill (see [Skills](./skills.mdx)) so the agent knows the loop: list, then claim, then complete or enrich.

```bash
npm i -g @input-output-hk/agent-review
```

The orchestration skill is plain markdown driving CLI commands; it makes no assumption about native Pi tools, so it works on any host that can read a file and run a CLI.

</TabItem>
<TabItem value="mcp-adapter" label="MCP adapter">

If a setup instead routes tool calls through a generic MCP adapter (for example, `pi-mcp-adapter`), point it at the `agent-review-mcp` binary the same way any MCP host would (see [MCP reference: Host wiring](./mcp.md#host-wiring)):

```json
{ "command": "npx", "args": ["-y", "@input-output-hk/agent-review", "serve"] }
```

</TabItem>
</Tabs>

## Publishing

`@input-output-hk/agent-review-pi` publishes to GitHub Packages on release, the same as the core package. It depends on `@input-output-hk/agent-review`, so the core package must publish first; the `publish` workflow does exactly that, building and publishing the core package before it builds and publishes the pi package in the same run. To publish the pi package by hand (for example, to re-publish it alone), run from the repo root after the core package is already on the registry:

```bash
npm run -w pi build && npm publish -w pi
```
