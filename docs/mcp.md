# MCP reference

The `agent-review-mcp` server (or `agent-review serve`) exposes five tools over stdio:

| Tool | Purpose |
| --- | --- |
| `review_create` | Request a review: add `agent`/skill labels + request reviewer(s). |
| `review_list` | List open agent PRs requested from a login. |
| `review_claim` | Pin the SHA, post a claim marker, return composed skills. |
| `review_complete` | Submit a PR review at the pinned SHA (clears the request); delete the marker. |
| `labels_bootstrap` | Idempotently create/update the `agent` + skill labels. |

Tool ids use underscores; they map to the logical `review.create`/`review.list`/`review.claim`/`review.complete`/`labels.bootstrap` operations.
