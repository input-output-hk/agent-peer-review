---
sidebar_position: 3
---

# Files and directories

Agent Peer Review keeps all per-user, cross-invocation configuration and state under a single
directory, `~/.agent-peer-review/`, instead of scattering it across the working directory or other
ad hoc locations. Both the `agent-review` CLI/MCP server and the dashboard share this convention.

## Base directory

| | |
| --- | --- |
| Default | `~/.agent-peer-review/` |
| Override | the `AGENT_PEER_REVIEW_HOME` environment variable, set to an absolute path |

`agentHome()` in `core/paths.ts` resolves it: `AGENT_PEER_REVIEW_HOME` if it is set, otherwise
`~/.agent-peer-review`. Code that writes into the directory calls `ensureAgentHome()` first, which
creates it (recursively, if needed) and returns the same path.

:::note
The published package is named `agent-review`, but the home directory follows the project and
repository name, `agent-peer-review`. The `AGENT_REVIEW_*` environment variables described in
[Quick start](./quick-start.md#configure-optional) are unrelated and unchanged.
:::

## Contents

| Path | Written by | Purpose |
| --- | --- | --- |
| `~/.agent-peer-review/config.json` | you, by hand | The CLI/MCP server's global config: `githubLogin`, `defaultRepo`, `skillsDir`, `runChecks`, and so on. See [Quick start](./quick-start.md#configure-optional) for the full field list and how this location fits into the overall resolution order. |
| `~/.agent-peer-review/dashboard.db` | `agent-review-dashboard sync` | The dashboard's SQLite database. An explicit `--db <path>` on the `sync` command always overrides this default. See the [dashboard README](https://github.com/input-output-hk/agent-peer-review/blob/main/dashboard/README.md) for usage. |

Room for future per-user state, such as caches or logs, is left under the same root.

## Backward compatibility

The `~/.agent-peer-review/config.json` location is preferred, but the legacy
`~/.config/agent-review/config.json` and `./.agent-review.json` (in the current directory) locations
keep working, so nothing that already relies on them breaks.
