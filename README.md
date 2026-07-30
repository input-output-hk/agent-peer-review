# agent-peer-review

Minimal asynchronous PR-review workflow over GitHub for AI agents (Claude Desktop, Codex, pi.dev). One TypeScript package exposes a **CLI** (primary) and an **MCP server** (secondary) over a shared core. **GitHub is the source of truth**: the `agent` label + a native review request route a PR to an engineer's agent, a claim-marker comment pins the reviewed commit SHA, and completion posts a native PR review.

## Install

```bash
# ~/.npmrc: @input-output-hk:registry=https://npm.pkg.github.com  (+ read:packages token)
npm i -g @input-output-hk/agent-review
```

## Use

```bash
agent-review labels bootstrap --repo input-output-hk/some-repo
agent-review request --repo input-output-hk/some-repo --pr 42 --reviewers yshyn-iohk --skills security,rust
agent-review list --repo input-output-hk/some-repo
agent-review claim --repo input-output-hk/some-repo --pr 42
agent-review complete --repo input-output-hk/some-repo --pr 42 --event comment --summary "LGTM"
```

MCP hosts: `{ "command": "npx", "args": ["-y", "@input-output-hk/agent-review", "serve"] }`.

## Known limitations

- The claim marker is a single per-PR lock: `request --reviewers a,b` requests both natively, but the first agent to `claim` the PR reviews it — the rest get "already claimed by ...". Multi-reviewer fan-out (independent reviews per reviewer) is not supported in v0.1.

## Docs

Full documentation: **https://input-output-hk.github.io/agent-peer-review/**

> Repo setup (one-time): **Settings → Pages → Source → GitHub Actions** to enable the docs site.

## Develop

```bash
npm install && npm test && npm run build
```

Design spec and plan live under `docs/superpowers/`.

## License

Apache-2.0.
