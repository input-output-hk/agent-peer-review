# agent-peer-review

Minimal asynchronous PR-review workflow over GitHub for AI agents (Claude Desktop, Codex, pi.dev). One TypeScript package exposes a **CLI** (primary) and an **MCP server** (secondary) over a shared core. **GitHub is the source of truth**: the `ai-review` label + a native review request route a PR to an engineer's agent, a claim-marker comment pins the reviewed commit SHA, and completion posts a native PR review.

## Install

```bash
# ~/.npmrc: @input-output-hk:registry=https://npm.pkg.github.com  (+ read:packages token)
npm i -g @input-output-hk/agent-review
```

Then run `agent-review init --repo owner/name` for a guided setup: it authenticates against GitHub, writes `~/.agent-peer-review/config.json`, bootstraps the `ai-review` label profile, and prints an MCP config snippet. See [`AGENTS.md`](AGENTS.md) for the full install contract, including what an AI agent needs to install and configure this on its own.

## Use

```bash
agent-review labels bootstrap --repo input-output-hk/some-repo
HEAD_SHA="$(git rev-parse HEAD)"
agent-review self-review --repo input-output-hk/some-repo --pr 42 --reviewed-sha "$HEAD_SHA" \
  --what-changed "Implemented the bounded review workflow." \
  --how-verified "Applied the fix in the shared core and ran the relevant checks." \
  --why-ready "No self-review findings remain; the PR is ready for peer review."
agent-review request --repo input-output-hk/some-repo --pr 42 --reviewers yshyn-iohk --skills security,api
agent-review list --repo input-output-hk/some-repo
agent-review claim --repo input-output-hk/some-repo --pr 42
agent-review complete --repo input-output-hk/some-repo --pr 42 --event comment --summary "LGTM" --workspace .
```

MCP hosts: `{ "command": "npx", "args": ["-y", "@input-output-hk/agent-review", "serve"] }`.

## Expedition taskflows

Three [pi-taskflow](https://www.npmjs.com/package/pi-taskflow) flows sweep your repositories on demand: `pr-requester` moves your own pull requests forward, `pr-reviewer` works the reviews requested from you, and `pr-steward` handles bot dependency upgrades. All three are **propose-only by default**: the agent comments what it would do and merges nothing unless you opt in per invocation. See [Expedition taskflows](docs/taskflows.md).

## Panel reviews

Multiple requested reviewers now run as a concurrent panel: the earliest to claim is the anchor and posts the primary review, and every other claimant is an enricher that adds one consolidated second opinion once the primary lands. See [Panel review (multiple reviewers)](docs/lifecycle.md#panel-review-multiple-reviewers) for the full flow.

## Docs

Full documentation: **https://input-output-hk.github.io/agent-peer-review/**

> Repo setup (one-time): **Settings → Pages → Source → GitHub Actions** to enable the docs site.

## Develop

```bash
npm install && npm test && npm run build
```

Architecture decisions are recorded as ADRs under [`docs/adr/`](docs/adr/) (rendered in the docs site under "Architecture Decisions").

## License

Apache-2.0.
