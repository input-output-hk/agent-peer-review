# Quick start

## Install (GitHub Packages)

`~/.npmrc`:

```ini
@input-output-hk:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```bash
npm i -g @input-output-hk/agent-review
```

## Configure (optional — login auto-detected)

`~/.config/agent-review/config.json`:

```json
{ "runChecks": false }
```

## Bootstrap labels on a repo

```bash
agent-review labels bootstrap --repo input-output-hk/some-repo
```

## Request a review

```bash
agent-review request --repo input-output-hk/some-repo --pr 42 --reviewers yshyn-iohk --skills security,rust
```

## Wire into a host

- **Claude Desktop / MCP hosts:**
  ```json
  { "command": "npx", "args": ["-y", "@input-output-hk/agent-review", "serve"] }
  ```
- **CLI hosts (Codex, pi.dev):** install the `agent-review` binary and load the `orchestration` skill so the agent drives `list → claim → complete`.
