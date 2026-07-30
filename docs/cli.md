---
sidebar_position: 6
---

# CLI reference

`agent-review` exposes nine commands: five that drive the review flow (`request`, `list`, `claim`, `complete`, and `labels bootstrap`), and four small utilities (`config`, `whoami`, `skills list`, and `serve`). Every command and flag on this page is read straight from `cli/index.ts`.

## Global options

| Option | Applies to | Meaning |
| --- | --- | --- |
| `-c, --config <path>` | every command | An explicit config file path. Takes priority over every other tier in the resolution order described in [Quick start](./quick-start.md#configure-optional). |
| `--repo <owner/name>` | `request`, `list`, `claim`, `complete`, `labels bootstrap` | The repository to act on. Optional if `defaultRepo` is set in your config; the command exits with an error if neither is provided. |

## `config`

Prints the fully resolved config as JSON, after applying the file-resolution order and defaults.

```bash
agent-review config
```

```json
{ "githubLogin": null, "defaultRepo": "input-output-hk/some-repo", "skillsDir": null, "runChecks": false }
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
["security","architecture","performance","testing","api","rust","react-native","did","oid4vc","cryptography","documentation"]
```

## `labels bootstrap`

Idempotently creates or updates the `agent` trigger label plus one label per skill name on the target repository. See [Labels and routing](./labels.md) for exactly how `created`/`updated`/`unchanged` is decided.

- `--repo <owner/name>`

```bash
agent-review labels bootstrap --repo input-output-hk/some-repo
```

## `request`

Adds the `agent` label (plus any skill labels you pass) and requests the review from one or more GitHub logins via the native Reviewers field.

- `--repo <owner/name>`
- `--pr <n>` (required)
- `--reviewers <csv>` (required): comma-separated GitHub logins.
- `--skills <csv>` (optional): comma-separated skill names; unrecognized names are silently dropped.
- `--note <text>` (optional): posted as a plain issue comment alongside the request.

```bash
agent-review request --repo input-output-hk/some-repo --pr 42 \
  --reviewers yshyn-iohk --skills security,rust --note "focus on the crypto changes"
```

## `list`

Lists open, `agent`-labeled pull requests requested from a login, with each row's current claim state if one exists.

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

## `serve`

Runs the MCP server over stdio. Equivalent to invoking the `agent-review-mcp` binary directly; see [MCP reference](./mcp.md).

```bash
agent-review serve
```
