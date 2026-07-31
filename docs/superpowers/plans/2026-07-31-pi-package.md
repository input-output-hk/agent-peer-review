# pi.dev Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship `@input-output-hk/agent-review-pi`, a Pi Package (TypeScript extension registering the six review tools over `core`, plus a Pi skill), installable via `pi install npm:@input-output-hk/agent-review-pi`.

**Architecture:** A new `pi/` workspace whose extension is another thin adapter over the existing `core` (mirrors `mcp/server.ts`; identical `{content:[{type:"text",text}]}` return shape). Root becomes an npm workspace so `pi` resolves the local core in dev.

**Tech Stack:** TypeScript (NodeNext, strict) · `@earendil-works/pi-coding-agent` 0.83 (peer) · `typebox` 1.3.9 (peer) · Vitest. Depends on `@input-output-hk/agent-review` (core).

## Global Constraints
- ESM `.js` specifiers, NodeNext, strict; GPG+DCO commits (`git commit -S -s`, no manual Signed-off-by).
- This branch is stacked on the context branch (PR #4). The pi package needs the full core (`enrichReview`, `listReviews`, languages/context) which lives there.
- Pi return shape: `{ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }`. Six tools: `review_create`, `review_list`, `review_claim`, `review_complete`, `review_enrich`, `labels_bootstrap` (mirror `mcp/server.ts`).
- Do NOT change the root package's published `files`/behavior. Adding `"workspaces": ["pi"]` to root package.json is the only root change (dev/install-time).
- No em dashes in docs/skill prose (IO brand).

---

### Task 1: Workspace + pi package scaffold

**Files:** Modify root `package.json` (+ `.gitignore`); create `pi/package.json`, `pi/tsconfig.json`.

- [ ] **Step 1:** Root `package.json`: add `"workspaces": ["pi"]` (leave everything else, incl. `files`, unchanged). Root `.gitignore`: add `pi/dist/`.
- [ ] **Step 2:** Create `pi/package.json`:
```json
{
  "name": "@input-output-hk/agent-review-pi",
  "version": "0.1.0",
  "description": "pi.dev integration for the agent peer-review workflow (extension + skill).",
  "license": "Apache-2.0",
  "type": "module",
  "engines": { "node": ">=20" },
  "files": ["dist", "skills"],
  "keywords": ["pi-package"],
  "publishConfig": { "registry": "https://npm.pkg.github.com" },
  "pi": { "extensions": ["./dist/extension.js"], "skills": ["./skills"] },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": { "@input-output-hk/agent-review": "^0.1.0" },
  "peerDependencies": { "@earendil-works/pi-coding-agent": ">=0.83.0", "typebox": "^1.3.9" },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "^0.83.0",
    "typebox": "^1.3.9",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```
- [ ] **Step 3:** Create `pi/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "outDir": "dist", "declaration": true, "strict": true,
    "esModuleInterop": true, "skipLibCheck": true, "forceConsistentCasingInFileNames": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```
- [ ] **Step 4:** From repo root, `npm install` (installs the workspace; symlinks `pi/node_modules/@input-output-hk/agent-review` → the root package). Confirm: `ls -la pi/node_modules/@input-output-hk/` shows the symlink; `npm view @earendil-works/pi-coding-agent version` (sanity) and that `pi`'s devDeps installed. Verify the root package still builds/tests: `npm run build && npm test` at root (unaffected).
- [ ] **Step 5: Commit** `chore(pi): scaffold @input-output-hk/agent-review-pi workspace`.

---

### Task 2: The Pi extension (+ tests)

**Files:** Create `pi/src/extension.ts`, `pi/src/extension.test.ts`.

**Interface:** `export function registerTools(pi: ExtensionAPI, deps?: { gh?: () => GitHubGateway; config?: () => Config }): void` and `export default function (pi: ExtensionAPI): void`.

- [ ] **Step 1: Write the failing test** (`pi/src/extension.test.ts`). Use a fake `pi` capturing `registerTool` definitions, and inject `deps` with a stub gateway + config so no network/real Octokit is used. Assert: exactly the six tool names register (`review_create/list/claim/complete/enrich`, `labels_bootstrap`); and for at least `review_list` and `review_claim`, calling the captured `execute` with sample params invokes the injected gateway/ops and returns `{ content: [{ type: "text", text: <json> }] }`. Stub the core ops by injecting a fake `GitHubGateway` (a minimal object implementing the methods those two tools touch: `getAuthenticatedLogin`, `listReviewRequests`, `listComments`, `getPullRequest`, `listPullFiles`, `getFileContent`, `listDir`) plus a `config` returning `{ githubLogin: "me", skillsDir: null, runChecks: false }`. (Keep the fake minimal; only the methods the two exercised tools call.)
```ts
import { describe, it, expect } from "vitest";
import { registerTools } from "./extension.js";

function fakePi() {
  const tools: any[] = [];
  return { tools, registerTool: (def: any) => tools.push(def) };
}

describe("pi extension", () => {
  it("registers the six review tools", () => {
    const pi = fakePi();
    registerTools(pi as any, { gh: () => ({}) as any, config: () => ({ githubLogin: "me", skillsDir: null, runChecks: false }) as any });
    expect(pi.tools.map((t) => t.name).sort()).toEqual(
      ["labels_bootstrap", "review_claim", "review_complete", "review_create", "review_enrich", "review_list"]);
  });
  it("review_list wraps the core result in Pi content shape", async () => {
    const pi = fakePi();
    const gh = { getAuthenticatedLogin: async () => "me", listReviewRequests: async () => [], listComments: async () => [] } as any;
    registerTools(pi as any, { gh: () => gh, config: () => ({ githubLogin: null, skillsDir: null, runChecks: false }) as any });
    const list = pi.tools.find((t) => t.name === "review_list");
    const res = await list.execute("id1", { repo: "o/r" }, undefined, undefined, undefined);
    expect(res.content[0].type).toBe("text");
    expect(JSON.parse(res.content[0].text)).toEqual([]);
  });
});
```
- [ ] **Step 2: Run → FAIL** (`npm run -w pi test`).
- [ ] **Step 3: Implement `pi/src/extension.ts`** mirroring `mcp/server.ts`, with `Type` (typebox) params and injectable deps:
```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { hostname } from "node:os";
import {
  loadConfig, OctokitGateway, createReview, listReviews, claimReview, completeReview, enrichReview, bootstrap,
  type GitHubGateway, type Config,
} from "@input-output-hk/agent-review";

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

export function registerTools(
  pi: ExtensionAPI,
  deps: { gh?: () => GitHubGateway; config?: () => Config } = {},
): void {
  const gh = deps.gh ?? (() => new OctokitGateway());
  const cfg = deps.config ?? (() => loadConfig());

  pi.registerTool({ name: "review_create", label: "Request a review", description: "Add the agent label + skill labels and request reviewer(s).",
    parameters: Type.Object({ repo: Type.String(), pr: Type.Number(), skills: Type.Optional(Type.Array(Type.String())), reviewers: Type.Array(Type.String()), note: Type.Optional(Type.String()) }),
    async execute(_id, p) { return ok(await createReview(gh(), { repo: p.repo, pr: p.pr, skills: p.skills ?? [], reviewers: p.reviewers, note: p.note })); } });

  pi.registerTool({ name: "review_list", label: "List review requests", description: "Open PRs labeled agent requested from a login (defaults to yours).",
    parameters: Type.Object({ repo: Type.String(), reviewer: Type.Optional(Type.String()) }),
    async execute(_id, p) { return ok(await listReviews(gh(), { repo: p.repo, login: p.reviewer ?? cfg().githubLogin ?? undefined })); } });

  pi.registerTool({ name: "review_claim", label: "Claim a review", description: "Pin the head SHA, post a claim marker, return composed skills + context.",
    parameters: Type.Object({ repo: Type.String(), pr: Type.Number() }),
    async execute(_id, p) { return ok(await claimReview({ gh: gh(), config: cfg(), machine: hostname(), now: new Date().toISOString() }, { repo: p.repo, pr: p.pr })); } });

  pi.registerTool({ name: "review_complete", label: "Complete a review", description: "Submit a PR review at the pinned SHA and swap labels.",
    parameters: Type.Object({ repo: Type.String(), pr: Type.Number(), event: Type.Union([Type.Literal("approve"), Type.Literal("request-changes"), Type.Literal("comment")]), summary: Type.String(), comments: Type.Optional(Type.Array(Type.Object({ path: Type.String(), line: Type.Number(), body: Type.String() }))) }),
    async execute(_id, p) { return ok(await completeReview({ gh: gh(), config: cfg() }, p as any)); } });

  pi.registerTool({ name: "review_enrich", label: "Enrich a review", description: "Post a consolidated second opinion once the primary exists; else waiting/promote.",
    parameters: Type.Object({ repo: Type.String(), pr: Type.Number(), verdict: Type.Union([Type.Literal("agree"), Type.Literal("disagree"), Type.Literal("mixed")]), summary: Type.String(), newFindings: Type.Optional(Type.Array(Type.Object({ path: Type.String(), line: Type.Number(), body: Type.String() }))) }),
    async execute(_id, p) { return ok(await enrichReview({ gh: gh(), config: cfg(), ttlMs: 30 * 60_000, nowMs: Date.now() }, { repo: p.repo, pr: p.pr, overallVerdict: p.verdict, summary: p.summary, newFindings: p.newFindings })); } });

  pi.registerTool({ name: "labels_bootstrap", label: "Bootstrap labels", description: "Idempotently create/update the agent + skill labels.",
    parameters: Type.Object({ repo: Type.String() }),
    async execute(_id, p) { return ok(await bootstrap(gh(), { repo: p.repo })); } });
}

export default function (pi: ExtensionAPI): void {
  registerTools(pi);
}
```
- [ ] **Step 4: Run → PASS** (`npm run -w pi test`); `npm run -w pi typecheck` clean; `npm run -w pi build` produces `pi/dist/extension.js`.
  - Type resilience: if `ExtensionAPI` from `@earendil-works/pi-coding-agent` does not type-check the `registerTool` definition cleanly (unknown surface), define a minimal local `interface ExtensionAPI { registerTool(def: { name: string; label: string; description: string; parameters: unknown; execute: (...a: any[]) => Promise<{ content: Array<{ type: "text"; text: string }> }> }): void }` and use that; note the shim in the report. Prefer the real type.
- [ ] **Step 5: Commit** `feat(pi): extension registering the six review tools over core`.

---

### Task 3: Pi skill + package build/load verification

**Files:** Create `pi/skills/agent-review/SKILL.md`.

- [ ] **Step 1:** Write `pi/skills/agent-review/SKILL.md` with YAML frontmatter (`name: agent-review`, `description:` covering "act as an agent peer reviewer on pi.dev: list → claim → review → complete/enrich") and the loop body referencing the native tools (`review_list`, `review_claim`, `review_complete`, `review_enrich`), noting: claim returns `instructions` + auto-detected `languages` + `repoContext`; review at the pinned SHA; read the local checkout too; anchor completes, enrichers enrich; never merge. No em dashes. Match the Pi skill frontmatter rules (name: lowercase/hyphens; description <=1024 chars).
- [ ] **Step 2:** Verify the package is coherent: `npm run -w pi build`; confirm `pi/dist/extension.js` exists and its default export is a function (`node -e "import('./pi/dist/extension.js').then(m => console.log('default is fn:', typeof m.default === 'function', '| registerTools:', typeof m.registerTools === 'function'))"`). Confirm the `pi` manifest paths resolve (`./dist/extension.js` exists, `./skills` dir exists with `agent-review/SKILL.md`).
- [ ] **Step 3: Commit** `feat(pi): agent-review Pi skill + build verification`.

---

### Task 4: CI + docs + final gate

**Files:** Modify `.github/workflows/ci.yml`; create `docs/pi.md`; modify `docs/sidebars.ts`. (Publish: note in docs; optional publish.yml extension.)

- [ ] **Step 1:** `.github/workflows/ci.yml`: add a `pi` job that runs, from repo root, `npm ci` then `npm run -w pi typecheck && npm run -w pi test && npm run -w pi build`. (Root `npm ci` installs the workspace.) This adds a `pi` PR check.
- [ ] **Step 2:** Create `docs/pi.md`: what the Pi package is; install (`pi install npm:@input-output-hk/agent-review-pi`); the six tools (table); the `agent-review` skill; config (`githubLogin` auto-detected, token via `GITHUB_TOKEN`/`gh`); and the two fallback routes (drive the `agent-review` CLI via Pi's `bash` tool + orchestration skill; or `pi-mcp-adapter` against `agent-review-mcp`). Add `"pi"` to `docs/sidebars.ts`. No em dashes.
- [ ] **Step 3:** Optionally extend `.github/workflows/publish.yml` with a step to publish the pi workspace on release (`npm publish -w pi`), after the core publish. If added, keep `registry-url`/scope config. (If deferred, note it in `docs/pi.md` as a manual `npm publish -w pi`.)
- [ ] **Step 4: Final gate:** root `npm run typecheck && npm run check:schemas && npm test && npm run build` green (root unaffected); `npm run -w pi typecheck && npm run -w pi test && npm run -w pi build` green; `cd docs && npm run build` clean; `grep -rn '—' docs/pi.md pi/skills` returns nothing.
- [ ] **Step 5: Commit** `ci,docs(pi): pi workspace CI check + pi.dev integration docs`.

---

## Self-Review (during planning)
- **Spec coverage:** separate package + workspace (T1); extension w/ six tools + injectable deps + tests (T2); Pi skill + build/manifest verification (T3); CI + docs + publish note (T4). Type-resilience shim (T2 step 4). Root unaffected (T1). Merge order (stacked on #4) noted in Global Constraints.
- **Type consistency:** `registerTools(pi, deps)` signature stable T2↔tests; core ops imported from `@input-output-hk/agent-review` match their real signatures (createReview/listReviews/claimReview/completeReview/enrichReview/bootstrap). Return shape `ok()` identical to `mcp/server.ts`.
- **Dependency risk:** `@earendil-works/pi-coding-agent` + `typebox` verified present on npm; peer+dev so it type-checks in dev and the Pi host provides them at runtime.
