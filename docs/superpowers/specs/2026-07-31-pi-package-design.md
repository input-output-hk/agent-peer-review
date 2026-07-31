# pi.dev Package (`@input-output-hk/agent-review-pi`) — Design Spec

- **Date:** 2026-07-31
- **Repo:** `input-output-hk/agent-peer-review`
- **Status:** Approved for planning
- **Builds on:** the full core (setup + panel + context). This branch is stacked on the context branch (PR #4); merge #4 first, then this PR retargets to `main`.

## 1. Goal

A **separate npm package**, `@input-output-hk/agent-review-pi`, that integrates the agent peer-review workflow natively into **pi.dev** (`@earendil-works/pi-coding-agent`, a minimal terminal coding harness). It is a **Pi Package**: a TypeScript **extension** registering the review tools over the existing `core`, plus a Pi **skill** that drives the loop. Installable with `pi install npm:@input-output-hk/agent-review-pi`.

This is simply another thin adapter over `core` (alongside `cli/` and `mcp/`); the Pi tool return shape `{ content: [{ type: "text", text }] }` is identical to the MCP adapter's.

## 2. Verified facts (from the pi.dev docs + npm)

- Pi extension = a default-export factory `(pi: ExtensionAPI) => void | Promise<void>`; tools via `pi.registerTool({ name, label, description, parameters, execute })`; params use **typebox** `Type.Object({...})`; `execute(toolCallId, params, signal, onUpdate, ctx)` returns `{ content: [{ type: "text", text }], details? }`.
- Pi discovers extensions from `package.json` `pi.extensions` (and `.pi/extensions/*.ts`), and skills from `pi.skills` / `skills/` in node modules. A **Pi Package** = `package.json` with `keywords: ["pi-package"]` + a `pi` manifest. Install: `pi install npm:@scope/pkg`.
- npm names confirmed present: **`@earendil-works/pi-coding-agent` @ 0.83.0** and **`typebox` @ 1.3.9** (both public/installable).

## 3. Package layout (npm workspace)

The repo becomes a minimal npm workspace so the Pi package resolves the local core during dev/test:

- Root `package.json`: add `"workspaces": ["pi"]` (dev/install-time only; the published `@input-output-hk/agent-review` contents and its `files` allowlist are unchanged).
- New `pi/` directory:
  ```
  pi/
    package.json        name @input-output-hk/agent-review-pi; pi manifest; keywords ["pi-package"]
    tsconfig.json       NodeNext, strict, outDir dist
    src/extension.ts    registerTools() + default factory
    src/extension.test.ts
    skills/agent-review/SKILL.md   Pi orchestration skill (frontmatter)
    dist/               (built, gitignored)
  ```
- `pi/package.json`:
  - `dependencies`: `{ "@input-output-hk/agent-review": "^0.1.0" }` (the core package; resolved locally via the workspace in dev, from GitHub Packages at install).
  - `peerDependencies`: `{ "@earendil-works/pi-coding-agent": ">=0.83.0", "typebox": "^1.3.9" }` (provided by the Pi host at runtime).
  - `devDependencies`: those two peers + `typescript`, `vitest` (for type-check/test/build).
  - `files`: `["dist", "skills"]`; `publishConfig.registry`: `https://npm.pkg.github.com`.
  - `keywords`: `["pi-package"]`; `pi`: `{ "extensions": ["./dist/extension.js"], "skills": ["./skills"] }`.
  - scripts: `build` (`tsc`), `test` (`vitest run`), `typecheck`.

## 4. Extension (`pi/src/extension.ts`)

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig, OctokitGateway, createReview, listReviews, claimReview, completeReview, enrichReview, bootstrap, type GitHubGateway, type Config } from "@input-output-hk/agent-review";
```

- `export function registerTools(pi: ExtensionAPI, deps: { gh?: () => GitHubGateway; config?: () => Config } = {}): void` — registers all six tools; `gh`/`config` default to `() => new OctokitGateway()` / `() => loadConfig()` but are **injectable for tests**.
- `export default function (pi: ExtensionAPI) { registerTools(pi); }` — the Pi entry point.
- Six tools mirroring the MCP adapter, each wrapping its result via `ok(data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] })`:
  - `review_create` `{repo, pr, skills?, reviewers, note?}` → `createReview`
  - `review_list` `{repo, reviewer?}` → `listReviews({repo, login: reviewer ?? config().githubLogin ?? undefined})`
  - `review_claim` `{repo, pr}` → `claimReview({gh, config, machine: hostname(), now: ISO}, {repo, pr})`
  - `review_complete` `{repo, pr, event, summary, comments?}` → `completeReview`
  - `review_enrich` `{repo, pr, verdict, summary, newFindings?}` → `enrichReview` (single attempt; host loops)
  - `labels_bootstrap` `{repo}` → `bootstrap`
- **Type resilience:** import `ExtensionAPI` from the peer. If the installed type surface is awkward, fall back to a minimal local structural interface (`{ registerTool(def): void }`) so the package always type-checks; note any such shim.

## 5. Skill (`pi/skills/agent-review/SKILL.md`)

Pi frontmatter (`name: agent-review`, `description: …when acting as an agent peer reviewer on pi.dev…`) + the loop: `review_list` → `review_claim` (pins SHA, returns instructions + auto-detected `languages` + `repoContext`) → review at the pinned SHA per the served skills, read the local checkout too → `review_complete` (anchor) or `review_enrich` (enricher). No em dashes (IO brand).

## 6. Testing

`pi/src/extension.test.ts`: a fake `pi` capturing `registerTool` calls, and injected `deps` (a stub `gh` + `config`, or mocked core ops via `vi.mock`), asserting: all six tools registered with the right names + typebox params; each `execute` maps params to the right core op and wraps the result in the `{content:[{type:"text",text}]}` shape. No network; core's test fake is not needed (core ops are already tested in the core package).

## 7. CI / publish / docs

- **CI**: extend root `.github/workflows/ci.yml` with a `pi` job (or steps) that builds + tests the workspace (`npm ci` at root installs the workspace; then `npm run -w pi typecheck && npm run -w pi test && npm run -w pi build`). This adds a `pi` required check.
- **Publish**: the pi package publishes to GitHub Packages on release (extend `publish.yml` to publish both workspaces, or a dedicated job). Requires the core package to be published first (dependency).
- **Docs**: a `docs/pi.md` page — install (`pi install npm:@input-output-hk/agent-review-pi`), the six tools, the skill, config (`githubLogin` auto-detected, `GITHUB_TOKEN`/`gh`), and the two fallback routes (drive the `agent-review` CLI via Pi's `bash`; or use `pi-mcp-adapter` against `agent-review-mcp`). Add to `sidebars.ts`.

## 8. Acceptance criteria

- `@input-output-hk/agent-review-pi` builds to `dist/extension.js` and type-checks against `@earendil-works/pi-coding-agent` + `typebox`.
- The extension registers all six tools; each `execute` is wired to the correct core op and returns the Pi text-content shape; tested without network.
- A valid Pi skill ships; `keywords: ["pi-package"]` + the `pi` manifest make it `pi install`-able and bundle the extension + skill.
- The root npm workspace resolves the local core in dev; the root package's own build/test/publish are unaffected.
- CI builds + tests the pi package; a `docs/pi.md` page documents install + tools + fallbacks.
- No em dashes in docs/skill prose; all commits GPG-signed + DCO.

## 9. Out of scope

Publishing to the public npm/Pi gallery (GitHub Packages only for now); a bespoke Pi UI/canvas; RPC/SDK-embedding mode; auto-running language linters (guidance only, per `runChecks`).
