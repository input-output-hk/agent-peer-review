---
sidebar_position: 6
---

# CLI reference

`agent-review` exposes eleven commands: a guided setup command (`init`), six that drive the review flow (`request`, `list`, `claim`, `complete`, `enrich`, and `labels bootstrap`), and four small utilities (`config`, `whoami`, `skills list`, and `serve`). Every command and flag on this page is read straight from `cli/index.ts`.

## Global options

| Option | Applies to | Meaning |
| --- | --- | --- |
| `-c, --config <path>` | every command | An explicit config file path. Takes priority over every other tier in the resolution order described in [Quick start](./quick-start.md#configure-optional). |
| `--repo <owner/name>` | `request`, `list`, `claim`, `complete`, `enrich`, `labels bootstrap` | The repository to act on. Optional if `defaultRepo` is set in your config; the command exits with an error if neither is provided. |

## `config`

Prints the fully resolved config as JSON, after applying the file-resolution order and defaults.

```bash
agent-review config
```

```json
{ "githubLogin": null, "defaultRepo": "input-output-hk/some-repo", "skillsDir": null }
```

## `whoami`

Prints the GitHub login the CLI will act as: `config.githubLogin` if you set one, otherwise the login auto-detected from your token.

```bash
agent-review whoami
```

## `skills list`

Prints the built-in specialty names, `SKILL_NAMES` from `core/labels.ts`, as a JSON array.

```bash
agent-review skills list
```

```json
["security","architecture","performance","testing","api","react-native","did","oid4vc","cryptography","documentation","second-opinion"]
```

## `labels bootstrap`

Idempotently creates or updates the `ai-review` trigger label plus one label per skill name on the target repository. See [Labels and routing](./labels.md) for exactly how `created`/`updated`/`unchanged` is decided.

- `--repo <owner/name>`

```bash
agent-review labels bootstrap --repo input-output-hk/some-repo
```

## `init`

Guided setup: authenticates against GitHub, writes `~/.agent-peer-review/config.json` (only the keys you passed), bootstraps the `ai-review` trigger label plus the skill labels on every `--repo`, and prints the config path, the labels created or left unchanged per repo, a ready-to-paste MCP config snippet, and the orchestration skill's location. See [Quick start](./quick-start.md#guided-setup) for the full walkthrough and [`AGENTS.md`](https://github.com/input-output-hk/agent-peer-review/blob/main/AGENTS.md) for the install contract this command backs.

- `--repo <owner/name...>` (repeatable): one or more repositories to bootstrap.
- `--reviewer <login...>` (repeatable, optional): default reviewer login(s), written to the `reviewers` config field; see [Configure](./quick-start.md#configure-optional). `request` (and the MCP/pi `review_create` tool) fall back to this list when a call omits reviewers.
- `--known-agent-login <login...>` (repeatable, optional): GitHub login(s) the expedition safety gate should treat as an agent rather than a human, written to the `knownAgentLogins` config field; see [Configure](./quick-start.md#configure-optional). Named in the printed summary below, since it is easy to forget.
- `--capture-metadata` (optional): opt in to durable review metadata capture; see [Review metadata capture](./metadata-capture.md).
- `--model <m>`, `--agent <a>`, `--tool-version <v>` (optional): only meaningful alongside `--capture-metadata`.
- `--yes` (optional): non-interactive. Without it, and without `--repo`, `init` prompts for input when run from a terminal; with neither `--repo` nor a terminal, it exits with guidance instead of hanging.

```bash
agent-review init --repo input-output-hk/some-repo --reviewer patextreme --known-agent-login some-agent-bot --yes
```

On a token or authentication failure, `init` prints a friendly message ("Could not authenticate to GitHub. Set `GITHUB_TOKEN` or run `gh auth login`.") and exits with a non-zero status instead of a raw stack trace.

`init` also makes a best-effort, read-only probe of the Dependabot alerts endpoint against the first `--repo`, and prints a warning to stderr if the token cannot read it; see [Recommended token scope](https://github.com/input-output-hk/agent-peer-review/blob/main/SECURITY.md#recommended-token-scope) in `SECURITY.md`. The probe never fails `init` itself, and the permission it checks for is unrelated to requesting, claiming, or completing a review.

## `request`

Adds the `ai-review` label (plus any skill labels you pass) and requests the review from one or more GitHub logins via the native Reviewers field.

- `--repo <owner/name>`
- `--pr <n>` (required)
- `--reviewers <csv>` (optional): comma-separated GitHub logins. Defaults to the `reviewers` config field (see [Configure](./quick-start.md#configure-optional)) when omitted; the command exits with an error if both are empty.
- `--skills <csv>` (optional): comma-separated skill names; unrecognized names are silently dropped.
- `--note <text>` (optional): posted as a plain issue comment alongside the request.

```bash
agent-review request --repo input-output-hk/some-repo --pr 42 \
  --reviewers yshyn-iohk --skills security,cryptography --note "focus on the crypto changes"
```

## `list`

Lists open, `ai-review`-labeled pull requests requested from a login, with each row's current claim state if one exists.

- `--repo <owner/name>`
- `--reviewer <login>` (optional): defaults to your own resolved login.

```bash
agent-review list --repo input-output-hk/some-repo
```

## `claim`

Pins the pull request's current head SHA, posts a claim-marker comment, and returns the composed review task (PR metadata, pinned SHA, and the full text of the matched skills).

- `--repo <owner/name>`
- `--pr <n>` (required)

```bash
agent-review claim --repo input-output-hk/some-repo --pr 42
```

## `complete`

Submits a native GitHub PR review at the pinned SHA and deletes the claim marker.

- `--repo <owner/name>`
- `--pr <n>` (required)
- `--event <approve|request-changes|comment>` (required)
- `--summary <text|@file>` (required): literal text, or a path prefixed with `@` to read the summary from a file.
- `--comments <@file>` (optional): a JSON array of `{path, line, body}` objects, typically read from a file the same way.

```bash
agent-review complete --repo input-output-hk/some-repo --pr 42 \
  --event request-changes --summary @summary.md --comments @comments.json
```

## `enrich`

Used by an enricher in a panel review. Waits for the panel's primary review to exist, then submits one consolidated `COMMENT` review at the primary's commit and deletes the claim marker; if the anchor's claim has gone stale past `--timeout`, promotes to primary by calling `complete` instead. See [Panel review (multiple reviewers)](./lifecycle.md#panel-review-multiple-reviewers) for the full flow.

- `--repo <owner/name>`
- `--pr <n>` (required)
- `--verdict <agree|disagree|mixed>` (required)
- `--summary <text|@file>` (required): literal text, or a path prefixed with `@` to read the summary from a file.
- `--comments <@file>` (optional): a JSON array of `{path, line, body}` new findings, typically read from a file the same way.
- `--poll <seconds>` (optional): seconds between polls. Defaults to `5`.
- `--timeout <seconds>` (optional): seconds before giving up. Defaults to `1800`.

```bash
agent-review enrich --repo input-output-hk/some-repo --pr 42 --verdict mixed --summary @summary.md --comments @comments.json
```

## `serve`

Runs the MCP server over stdio. Equivalent to invoking the `agent-review-mcp` binary directly; see [MCP reference](./mcp.md).

```bash
agent-review serve
```
