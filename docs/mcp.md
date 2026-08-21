---
sidebar_position: 7
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# MCP reference

The `agent-review-mcp` binary (equivalently, `agent-review serve`) starts an MCP server over stdio, built with `@modelcontextprotocol/sdk`. It registers eight tools: the six review operations plus author self-review and the single follow-up issue operation.

`core` also exports five expedition operations that remain Pi-only (`stabilize`, `expedite`, `requestPeerReview`, `approveDependencyUpgrade`, and `watchAndReReview`). Self-review and follow-up are available here because they are part of the cross-host review handoff contract.

Every tool returns its result the same way: a single text content block holding the same JSON you would get back from the equivalent CLI command, pretty-printed with two-space indentation.

## Naming: underscores here, dots in prose

Tool ids use underscores (`review_create`), following common MCP naming convention for identifiers. This documentation, and the design notes behind it, refer to the same logical operations with dots (`review.create`) because that reads better in prose. `review_create` and `review.create` name the exact same operation; only the spelling differs by audience.

## The eight tools

| Tool id | Logical operation | Purpose |
| --- | --- | --- |
| `review_create` | `review.create` | Add the `ai-review` label plus any skill labels, and request the reviewer(s) natively. |
| `review_list` | `review.list` | List open, `ai-review`-labeled pull requests requested from a login (defaults to yours). |
| `review_claim` | `review.claim` | Pin the head SHA, post a claim marker, and return the composed review task. |
| `review_self_review` | `review.self-review` | Record the PR author's successful exact-head `Self-review` summary. |
| `review_followup` | `review.followup` | Create or return the one meaningful review follow-up issue allowed for the PR. |
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

When the authenticated caller is the PR author, `review_create` refuses the write until `review_self_review` has recorded a successful pass at the current head. A maintainer requesting a review on somebody else's PR is not gated.

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
| `reviewedSha` | string | required for `request-changes`; exact claim SHA |
| `mode` | `initial`, `rereview`, or `convergence` | no; must match claim history if passed |
| `findings` | structured finding array | required to contain a confirmed blocker for `request-changes` |
| `workspace` | string path | no, defaults to server working directory |

### `review_enrich`

| Field | Type | Required |
| --- | --- | --- |
| `repo` | string | yes |
| `pr` | number | yes |
| `verdict` | string enum: `agree`, `disagree`, or `mixed` | yes |
| `summary` | string | yes |
| `newFindings` | array of `{ path: string, line: number, body: string }` | no |
| `reviewedSha`, `mode`, `findings`, `workspace` | exact-head structured fields | no; same semantics as completion |
| `assessments` | `{ findingId, disposition, rationale }[]` | required for every structured primary finding |

Unlike the other tools, `review_enrich` makes a single attempt: it does not poll. It reports `waiting` or `promote` immediately, and the calling host is responsible for looping (the CLI's `enrich` command does this for you).

### `review_self_review`

Takes `repo`, `pr`, `reviewedSha`, `whatChanged`, `howVerified`, `whyReady`, and optional `workspace`. It posts one author-authenticated current-head comment titled `Self-review`; dirty, stale, and non-author calls fail.

### `review_followup`

Takes `repo`, `pr`, `reviewedSha`, `title`, `problem`, `rationale`, `acceptanceCriteria`, `findingIds`, and optional `workspace`. Minimum content and acceptance criteria prevent issue-shaped noise, and the operation creates at most one issue per PR across retries.

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
