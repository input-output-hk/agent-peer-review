# Dashboard

`@input-output-hk/agent-review-dashboard` is a companion CLI that turns the pull request history
`agent-review` already writes to GitHub into a local, browsable record. A `sync` command pulls
agent-reviewed pull requests into a local SQLite database, and a `serve` command exposes that
database as a read-only HTTP API and UI on localhost. The dashboard reads the same GitHub state
everyone else sees (labels, reviews, comments); it does not add any state of its own.

## Getting it

:::note[Not published: build it from this repository]
The `dashboard` package is marked `private: true` and is not published to any registry, so there is
nothing to `npm install`. Build it from a checkout, and the `agent-review-dashboard` command below
resolves through the workspace:

```bash
git clone https://github.com/input-output-hk/agent-peer-review.git
cd agent-peer-review
npm install
npm run build                 # the root package, which the dashboard depends on
npm run -w dashboard build    # the dashboard's own CLI and UI bundle
npx -w dashboard agent-review-dashboard sync --repo owner/name
npx -w dashboard agent-review-dashboard serve
```

Every `agent-review-dashboard` invocation in the rest of this page assumes that build. Outside the
workspace, run it as `node dashboard/dist/cli.js` or put `dashboard/node_modules/.bin` on your
`PATH`.
:::

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
`/api/repos/:owner/:name/pulls/:number`, `/api/agents`, `/api/collaborators`, `/api/sync-runs`)
backs the dashboard user interface that `serve` hosts at `/`. `/api/agents` and `/api/collaborators`
both accept an optional `?repo=owner/name` filter.

## User interface

The dashboard ships a React single-page app: an Overview page (totals, verdict and model
distributions, recent activity, and last-sync status), a repository list, a per-repository pull
request list, and a per-pull detail view showing each review with its agent and model metadata and
the inline notes. Review summaries and note bodies are untrusted text and are always rendered
through a markdown sanitizer, so a review body can never inject scripts or load remote images.

Two aggregate views sit alongside those. **Agents** lists one row per captured `(agent, model)`
identity with its review count, its primary and second-opinion split, its verdict distribution,
its agreement breakdown, its average turnaround, and how many repositories it has worked in.
Reviews posted without metadata capture enabled collapse into a single "Unknown" row rather than
being attributed to an agent. **Collaborators** lists one row per pull request author with the
reviews their pull requests received, the verdicts received, and how many distinct agent
identities have reviewed them. Both views take a repository filter.

Two honesty notes carried into the interface. Verdict counts only include reviews that recorded a
verdict, so the buckets need not add up to the review count, and the views show raw counts rather
than shares of a total. The agreement breakdown is derived from posted second-opinion reviews,
which are body-attested text rather than an authenticated signal, so the column says so instead
of implying it was verified.

The UI is a static bundle. `serve` sends it for every non-API path, so deep links (for example,
`/repos/:owner/:name/pulls/:number`) and the browser back and forward buttons work.

```bash
npm run -w dashboard build    # type-check and bundle the UI into dashboard/public/
agent-review-dashboard serve  # serve the API and UI at http://127.0.0.1:4319
npm run -w dashboard dev      # Vite dev server for local UI work
```

`npm run -w dashboard build` writes the compiled assets to `dashboard/public/`, which `serve`
serves. For local UI development, run `serve` in one terminal and `npm run -w dashboard dev` in
another: the dev server proxies `/api` to the running `serve` instance so the UI has live data.

## Files and authentication

The dashboard follows the same `~/.agent-peer-review/` home directory as `agent-review`; see
[Files and directories](./files-and-directories.md) for the full convention, including the
`AGENT_PEER_REVIEW_HOME` override. `sync` needs a `GITHUB_TOKEN` (or a cached `gh auth token`) with
read-only access to Pull requests and Issues. `serve` needs no token at all: it only reads the local
database `sync` already wrote.

See the [dashboard README](https://github.com/input-output-hk/agent-peer-review/blob/main/dashboard/README.md) for the full command reference and known limitations.
