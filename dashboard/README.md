# agent-review-dashboard

Local dashboard for agent PR-review activity. Phase 1 is ingestion only: a CLI command reads
agent-reviewed pull requests from GitHub and stores them in a local SQLite database. There is no
API server and no UI yet; those are later phases.

## What it stores

`sync` walks every requested repository, finds pull requests touched by the agent-review workflow
(labeled `agent`, or reviewed by the agent login), and writes them into SQLite: the pull request
itself, its reviews (with the primary/second-opinion role, verdict, and model metadata parsed from
the review body), inline review notes, claim markers, and participants (author and reviewers). Each
run is also recorded in a `sync_run` table with its counts and outcome.

Each sync fully replaces the reviews, notes, claims, and participants for every pull request it
visits, so the database always reflects the current state of GitHub for the PRs in scope.

## Usage

```bash
agent-review-dashboard sync --repo <owner/name> [--db <path>]
```

- `-r, --repo <owner/name...>`: one or more repositories to sync (repeat the flag for more than one).
- `-d, --db <path>`: SQLite database file to write to. Defaults to `~/.agent-peer-review/dashboard.db`
  (see [Files and directories](#files-and-directories) below). The file, and any missing parent
  directory, are created on first run if they do not already exist.
- `-l, --login <login>`: the agent login to match pull requests against. Defaults to the login of
  the authenticated `GITHUB_TOKEN` user.

Example:

```bash
agent-review-dashboard sync --repo input-output-hk/agent-peer-review
```

## Files and directories

The dashboard follows the same `~/.agent-peer-review/` convention as the `agent-review` CLI:

- `~/.agent-peer-review/dashboard.db`: the `sync` command's default database path.
- `~/.agent-peer-review/config.json`: the `agent-review` CLI's global config (this package does not
  read it, but it shares the same home directory).

Set the `AGENT_PEER_REVIEW_HOME` environment variable to an absolute path to move the whole directory
elsewhere, for example in CI or when running multiple isolated instances on one machine:

```bash
AGENT_PEER_REVIEW_HOME=/tmp/agent-peer-review agent-review-dashboard sync --repo input-output-hk/agent-peer-review
```

An explicit `--db <path>` always overrides the default location, regardless of
`AGENT_PEER_REVIEW_HOME`:

```bash
agent-review-dashboard sync --repo input-output-hk/agent-peer-review --db ./dashboard.db
```

This package is private and not published, so within this monorepo run it via the built entry
point after `npm run build && npm run -w dashboard build`:

```bash
node dashboard/dist/cli.js sync --repo input-output-hk/agent-peer-review --db ./dashboard.db
```

## Authentication

The CLI reads `GITHUB_TOKEN` from the environment. A fine-grained personal access token scoped to
read-only access on Pull requests and Issues is sufficient; no write scopes are needed because
Phase 1 only reads from GitHub. If `GITHUB_TOKEN` is not set, it falls back to `gh auth token` (the
GitHub CLI's cached credential).

## Known limitations

- **Full re-scan each run.** `sync` re-fetches every matching pull request on every invocation.
  There is no incremental cursor, so cost and runtime grow with the size of the repository's
  history.
- **No Search-API windowing yet.** Pull request discovery uses the GitHub Search API, which caps
  results at 1000 per query and has its own rate limit. Very active repositories may need
  windowing (for example, by date range) that is not implemented yet.
- **Requester attribution is not captured.** The dashboard records who authored and who reviewed a
  pull request, but not who originally requested the review.

## Native dependency

`better-sqlite3` is a native module and is pinned to `12.9.0` for prebuilt binary compatibility with
Node 20 and 22. If a prebuild is not available for your platform, rebuild it from source:

```bash
npm rebuild better-sqlite3 --build-from-source
```
