---
sidebar_position: 6
---

# CLI reference

`agent-review` exposes thirteen commands: setup, the review lifecycle, the implementer self-review and follow-up gates, and small utilities. Every command and flag on this page is read straight from `cli/index.ts`.

## Global options

| Option | Applies to | Meaning |
| --- | --- | --- |
| `-c, --config <path>` | every command | An explicit config file path. Takes priority over every other tier in the resolution order described in [Quick start](./quick-start.md#configure-optional). |
| `--repo <owner/name>` | `request`, `list`, `claim`, `self-review`, `followup`, `complete`, `enrich`, `labels bootstrap` | The repository to act on. Optional if `defaultRepo` is set in your config; the command exits with an error if neither is provided. |

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

`init` also makes a best-effort, read-only preflight against the first `--repo` for the expedition gate's checks, commit-status, branch-protection, and Dependabot-alert reads, and prints a warning to stderr if the token cannot read one; see [Recommended token scope](https://github.com/input-output-hk/agent-peer-review/blob/main/SECURITY.md#recommended-token-scope) in `SECURITY.md`. The preflight never fails `init` itself, and those permissions are unrelated to requesting, claiming, or completing a review. Contents write, needed only for an actual merge, cannot be probed safely without making a write.

## `request`

Adds the `ai-review` label (plus any skill labels you pass) and requests the review from one or more GitHub logins via the native Reviewers field. When the caller is the PR author, the current clean head must already have a successful authenticated `Self-review`; a maintainer requesting review on somebody else's PR is not gated.

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

The result includes `reviewContractVersion: 1` and bounded `reviewHistory` with the mode, prior SHAs, finding statuses, accepted risks, cycle count, and last verdict.

## `self-review`

Records the implementing author's successful exact-head pass as a PR comment titled `Self-review`. Fix issues and repeat the pass before calling this command. It rejects a dirty checkout, a moved head, or a caller who is not the PR author.

```bash
agent-review self-review --repo input-output-hk/some-repo --pr 42 \
  --reviewed-sha abc1234 --what-changed @what.md --how-verified @verification.md \
  --why-ready @ready.md --workspace ../some-repo
```

Every author-owned request surface (`request`, `review_create`, and `pr_request_review`) refuses to request an external peer at that head until this record exists.

## `followup`

Creates the one meaningful review follow-up issue allowed for a PR, or returns the existing issue. The issue must own at least one stable finding ID, explain the problem and proportionality decision, and include concrete acceptance criteria. It cannot be used from a dirty or stale checkout or by anyone other than the PR author.

```bash
agent-review followup --repo input-output-hk/some-repo --pr 42 --reviewed-sha abc1234 \
  --title "Redesign the parser boundary" --problem @problem.md --rationale @rationale.md \
  --acceptance-criteria @criteria.json --finding-ids shell-policy-parser --workspace ../some-repo
```

## `complete`

Submits a native GitHub PR review at the pinned SHA and deletes the claim marker.

- `--repo <owner/name>`
- `--pr <n>` (required)
- `--event <approve|request-changes|comment>` (required)
- `--summary <text|@file>` (required): literal text, or a path prefixed with `@` to read the summary from a file.
- `--comments <@file>` (optional): a JSON array of `{path, line, body}` objects, typically read from a file the same way.
- `--reviewed-sha <sha>` (required for `request-changes`, recommended for every result): the exact claim SHA reviewed.
- `--mode <initial|rereview|convergence>` (optional): must match `reviewHistory.mode` when passed.
- `--findings <@file>` (optional except that `request-changes` needs a confirmed blocker): structured stable-ID findings.
- `--workspace <path>` (optional, defaults to `.`): the checkout whose origin, clean state, and HEAD are attested.

```bash
agent-review complete --repo input-output-hk/some-repo --pr 42 \
  --event request-changes --summary @summary.md --comments @comments.json \
  --reviewed-sha abc1234 --mode initial --findings @findings.json --workspace ../some-repo
```

## `enrich`

Used by an enricher in a panel review. Waits for the panel's primary review to exist, then submits one consolidated `COMMENT` review at the primary's commit and deletes the claim marker; if the anchor's claim has gone stale past `--timeout`, promotes to primary by calling `complete` instead. See [Panel review (multiple reviewers)](./lifecycle.md#panel-review-multiple-reviewers) for the full flow.

- `--repo <owner/name>`
- `--pr <n>` (required)
- `--verdict <agree|disagree|mixed>` (required)
- `--summary <text|@file>` (required): literal text, or a path prefixed with `@` to read the summary from a file.
- `--comments <@file>` (optional): a JSON array of `{path, line, body}` new findings, typically read from a file the same way.
- `--reviewed-sha <sha>`, `--mode <mode>`, `--findings <@file>`, and `--workspace <path>`: the same exact-head structured contract as `complete`.
- `--assessments <@file>` (required when the primary has structured findings): one confirm/refute disposition and rationale per primary finding ID.
- `--poll <seconds>` (optional): seconds between polls. Defaults to `5`.
- `--timeout <seconds>` (optional): seconds before the CLI gives up polling. Defaults to `1800`; it does not change the fixed 30-minute claim-staleness threshold used to promote an enricher.

```bash
agent-review enrich --repo input-output-hk/some-repo --pr 42 --verdict mixed --summary @summary.md --comments @comments.json
```

## `serve`

Runs the MCP server over stdio. Equivalent to invoking the `agent-review-mcp` binary directly; see [MCP reference](./mcp.md).

```bash
agent-review serve
```
