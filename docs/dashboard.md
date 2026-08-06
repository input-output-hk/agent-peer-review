# Dashboard

`@input-output-hk/agent-review-dashboard` is a companion CLI that turns the pull request history
`agent-review` already writes to GitHub into a local, browsable record. A `sync` command pulls
agent-reviewed pull requests into a local SQLite database, and a `serve` command exposes that
database as a read-only HTTP API and UI on localhost. The dashboard reads the same GitHub state
everyone else sees (labels, reviews, comments); it does not add any state of its own.

## Sync

```bash
agent-review-dashboard sync --repo <owner/name> [--db <path>]
```

For each requested repository, `sync` finds pull requests touched by the agent-review workflow and
writes them into SQLite: the pull request itself, its reviews (with role, verdict, and model
metadata parsed from the review body), inline notes, claim markers, and participants. Every run
fully replaces that data for every pull request it visits, so the database always matches GitHub's
current state for the PRs in scope. Repeat `--repo` for more than one repository; `--login` picks
which agent's activity to match (defaults to the authenticated `GITHUB_TOKEN` user).

## Serve

```bash
agent-review-dashboard serve [--db <path>] [--port <n>] [--host <addr>]
```

`serve` reads the database `sync` wrote and serves it at `http://127.0.0.1:4319` by default;
`--port` and `--host` change where it binds, and `--db` points it at a different database file.

It is read-only and localhost-only by design:

- The database connection is opened read-only, so `serve` cannot write to it under any
  circumstance.
- Every request's `Host` header must resolve to `localhost`, `127.0.0.1`, or `::1`, and its `Origin`
  header, when present, must match the same allowlist; anything else gets a `403`. No CORS headers
  are sent, so a browser tab on another origin cannot read the API either.
- If the database at `--db` does not exist yet, `serve` prints a message telling you to run `sync`
  first instead of failing with a raw database error.

The HTTP API (`/api/overview`, `/api/repos`, `/api/repos/:owner/:name/pulls`,
`/api/repos/:owner/:name/pulls/:number`, `/api/sync-runs`) is complete. The page served at `/` is a
placeholder; a full dashboard user interface arrives in a later phase.

## Files and authentication

The dashboard follows the same `~/.agent-peer-review/` home directory as `agent-review`; see
[Files and directories](./files-and-directories.md) for the full convention, including the
`AGENT_PEER_REVIEW_HOME` override. `sync` needs a `GITHUB_TOKEN` (or a cached `gh auth token`) with
read-only access to Pull requests and Issues. `serve` needs no token at all: it only reads the local
database `sync` already wrote.

See the [dashboard README](https://github.com/input-output-hk/agent-peer-review/blob/main/dashboard/README.md) for the full command reference and known limitations.
