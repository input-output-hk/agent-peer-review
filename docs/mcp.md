---
sidebar_position: 7
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# MCP reference

The `agent-review-mcp` binary (equivalently, `agent-review serve`) starts an MCP server over stdio, built with `@modelcontextprotocol/sdk`. It registers six tools, one per operation in `core`, using [zod](https://zod.dev) schemas for input validation.

Every tool returns its result the same way: a single text content block holding the same JSON you would get back from the equivalent CLI command, pretty-printed with two-space indentation.

## Naming: underscores here, dots in prose

Tool ids use underscores (`review_create`), following common MCP naming convention for identifiers. This documentation, and the design notes behind it, refer to the same logical operations with dots (`review.create`) because that reads better in prose. `review_create` and `review.create` name the exact same operation; only the spelling differs by audience.

## The six tools

| Tool id | Logical operation | Purpose |
| --- | --- | --- |
| `review_create` | `review.create` | Add the `ai-review` label plus any skill labels, and request the reviewer(s) natively. |
| `review_list` | `review.list` | List open, `ai-review`-labeled pull requests requested from a login (defaults to yours). |
| `review_claim` | `review.claim` | Pin the head SHA, post a claim marker, and return the composed review task. |
| `review_complete` | `review.complete` | Submit a PR review at the pinned SHA (which clears the request), then delete the claim marker. |
| `review_enrich` | `review.enrich` | Post a consolidated second opinion once the primary review exists; otherwise report `waiting` or `promote`. |
| `labels_bootstrap` | `labels.bootstrap` | Idempotently create or update the `ai-review` label plus every skill label. |

## Input fields

### `review_create`

| Field | Type | Required |
| --- | --- | --- |
| `repo` | string | yes |
| `pr` | number | yes |
| `skills` | array of string | no, defaults to `[]` |
| `reviewers` | array of string | no, defaults to the config file's `reviewers` (see [Quick start: Configure](./quick-start.md#configure-optional)); the tool reports an error if both are empty |
| `note` | string | no |

### `review_list`

| Field | Type | Required |
| --- | --- | --- |
| `repo` | string | yes |
| `reviewer` | string | no, defaults to your resolved login |

### `review_claim`

| Field | Type | Required |
| --- | --- | --- |
| `repo` | string | yes |
| `pr` | number | yes |

### `review_complete`

| Field | Type | Required |
| --- | --- | --- |
| `repo` | string | yes |
| `pr` | number | yes |
| `event` | string enum: `approve`, `request-changes`, or `comment` | yes |
| `summary` | string | yes |
| `comments` | array of `{ path: string, line: number, body: string }` | no |

### `review_enrich`

| Field | Type | Required |
| --- | --- | --- |
| `repo` | string | yes |
| `pr` | number | yes |
| `verdict` | string enum: `agree`, `disagree`, or `mixed` | yes |
| `summary` | string | yes |
| `newFindings` | array of `{ path: string, line: number, body: string }` | no |

Unlike the other tools, `review_enrich` makes a single attempt: it does not poll. It reports `waiting` or `promote` immediately, and the calling host is responsible for looping (the CLI's `enrich` command does this for you).

### `labels_bootstrap`

| Field | Type | Required |
| --- | --- | --- |
| `repo` | string | yes |

These are the same shapes documented in full, with worked examples, on the [Schemas](./schemas.mdx) page; `review_create` validates against Review Request, `review_complete` against Review Result.

## Host wiring

Any MCP host can launch the server either through `npx`, with no local install, or against a globally installed binary.

<Tabs>
<TabItem value="npx" label="npx (no install)" default>

```json
{ "command": "npx", "args": ["-y", "@input-output-hk/agent-review", "serve"] }
```

</TabItem>
<TabItem value="global" label="Global install">

```json
{ "command": "agent-review-mcp" }
```

which is equivalent to:

```json
{ "command": "agent-review", "args": ["serve"] }
```

</TabItem>
</Tabs>

:::note
Most MCP hosts let you set environment variables per server entry. Use that to pass `GITHUB_TOKEN`, or `AGENT_REVIEW_CONFIG` to point the server at a specific config file, without depending on whatever environment the host process itself started with.
:::
