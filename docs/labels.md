---
sidebar_position: 4
---

# Labels and routing

Labels in Agent Peer Review carry exactly two independent pieces of information, and nothing else. Routing, in contrast, is never a label: it uses GitHub's own requested-reviewer mechanism.

| Purpose | Label(s) | Color | Set by |
| --- | --- | --- | --- |
| Trigger (required) | `agent` | `0e8a16` | requester, via `review.create` |
| Skill (zero or more, optional) | bare names: `security`, `architecture`, `performance`, `testing`, `api`, `rust`, `react-native`, `did`, `oid4vc`, `cryptography`, `documentation` | `5319e7` | requester, via `review.create` |

There are no `review`, `reviewer:*`, `skill:*`, or status labels of any kind. A basic request is `agent` plus a requested reviewer; add bare skill labels only when you want a specific specialty applied.

## Why routing is not a label

Early designs for workflows like this often add a `reviewer:alice` style label to say who should look at something. Agent Peer Review does not, because GitHub already has a mechanism for exactly that: the Reviewers field on a pull request. `review.create` calls the native `requestReviewers` API with the logins you pass to `--reviewers`, and `review.list` finds work with a plain GitHub search:

```text
is:pr is:open label:agent review-requested:<login>
```

An agent only ever processes pull requests that carry `agent` **and** were requested from its own login. This keeps the label surface tiny and lets you see exactly who a PR is waiting on from GitHub's normal UI, with no custom dashboard required.

## Bootstrapping the label profile

`labels.bootstrap` (CLI: `agent-review labels bootstrap`, MCP: `labels_bootstrap`) idempotently creates or updates the `agent` trigger label plus one label per name in `SKILL_NAMES`. Run it once per repository, and again any time a new skill is added, since it is safe to repeat: existing labels with the right color and description are left alone and reported as `unchanged`, mismatched ones are `updated`, and missing ones are `created`.

## Unrecognized labels are ignored, not errored

Skill matching is a simple membership check against the built-in `SKILL_NAMES` list, both when reading labels off a pull request and when composing labels for a new request:

- If a pull request carries labels beyond `agent` and its skills, such as GitHub's own default `documentation` label used loosely, or `bug`, or `wontfix`, the agent simply does not look at them. Only names in `SKILL_NAMES` are read as skills.
- If you request a review with `--skills sekurity` (a typo), that name is silently dropped from the labels that get added; it is not an error, and no `sekurity` label is created. Run `agent-review skills list` first if you are not sure of the exact spelling.

This is a deliberate trade-off: it means older agent versions keep working unmodified when a repository grows new labels for unrelated purposes, at the cost of failing silently on a typo instead of loudly.

:::caution[Known limitation: first-claim-wins, not fan-out]
The claim marker is a single lock per pull request, not one per reviewer. Requesting `--reviewers alice,bob` asks GitHub to request a review from both natively, but the first of the two agents to run `review.claim` on that PR reviews it; the other sees "already claimed by ...". Independent, parallel reviews from multiple reviewers on the same pull request are not supported in v0.1.
:::
