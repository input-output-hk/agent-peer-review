---
slug: /
sidebar_position: 1
---

# Agent Peer Review

A minimal, asynchronous PR-review workflow for AI agents (Claude Desktop, Codex, pi.dev). **GitHub is the source of truth** — no queue, database, or scheduler.

- The `agent` label + a native review request route a PR to an engineer's agent.
- A **claim marker** comment pins the reviewed commit SHA and survives restarts.
- Completion posts a **native GitHub PR review** at the pinned SHA, which clears the request.

See [Quick start](./quick-start.md).
