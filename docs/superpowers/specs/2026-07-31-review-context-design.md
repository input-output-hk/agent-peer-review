# Review Context Loading (languages, domains, local repo) — Design Spec

- **Date:** 2026-07-31
- **Repo:** `input-output-hk/agent-peer-review`
- **Status:** Approved for planning
- **Builds on:** the setup + panel-review branches (extends `claim`).

## 1. Goal

Load the best possible context before an agent reviews a PR. Three sources, assembled at `claim` time and served in the composed review task (host-agnostic, consistent with the existing model):

1. **Language skills**, auto-selected from the PR's changed files.
2. **Domain skills** (deepened `security`/`cryptography`/`architecture`, plus the existing set), selected by label as today.
3. **Local repository context** from the reviewed repo itself (`AGENT.md`, `AGENTS.md`, `CLAUDE.md`, `.claude/**`, `.codex/**`), so repo-specific review conventions inform the review.

## 2. Approved decisions

- **Language set (~12):** `typescript`, `javascript`, `python`, `go`, `rust` (deepen existing), `haskell`, `java`, `kotlin`, `swift`, `scala`, `c-cpp` (C and C++ in one skill), `solidity`. Each skill's content is grounded with **web research** (authoritative style guides, common bug/security patterns, idioms, linters/tooling). `react-native` stays a label-selected framework skill (not extension-detected).
- **Domain deepening:** rewrite `security` around the **OWASP Top 10 (2021)**, and deepen `cryptography` and `architecture` with web-researched, authoritative guidance. Other domain skills unchanged.
- **Local-repo context = both:** `claim` fetches the repo-context files via the GitHub contents API at the pinned SHA (bounded, missing files skipped), **and** the orchestration skill instructs the agent to read them from its local checkout as a fallback/supplement.
- **Language selection = auto-detect:** `claim` reads the PR's changed files, maps extensions to languages, and serves the matching language skills. No label needed (a bare language label may still force-include, but detection is the default).

## 3. Extension → language map

`c-cpp` covers C and C++. `react-native` is not extension-detected.

| Language | Extensions |
|---|---|
| typescript | `.ts .tsx .mts .cts` |
| javascript | `.js .jsx .mjs .cjs` |
| python | `.py .pyi` |
| go | `.go` |
| rust | `.rs` |
| haskell | `.hs .lhs` |
| java | `.java` |
| kotlin | `.kt .kts` |
| swift | `.swift` |
| scala | `.scala .sc` |
| c-cpp | `.c .h .cpp .cc .cxx .hpp .hh .hxx` |
| solidity | `.sol` |

Languages are held in `core/languages.ts` as `LANGUAGE_EXTENSIONS` (name → extensions) with `detectLanguages(files: string[]): string[]` (dedup, sorted, only languages with a bundled `skills/lang/<name>.md`). Detection ignores unknown extensions.

## 4. Local repository context

Fetched by `claim` at the pinned SHA, **bounded** to keep payloads sane:

- Exact files: `AGENT.md`, `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`.
- Shallow directory listings of `.claude/` and `.codex/`: include their markdown files (e.g. `.claude/*.md`, `.codex/*.md`, `.claude/skills/*/SKILL.md`) up to a **file cap (10)** and a **total size cap (~64 KB)**. Missing paths are skipped silently; nothing fails the review.

Each included file becomes `repoContext: [{ path, content }]` in the review task. The orchestration skill also tells the agent to read these paths from its checkout, covering anything the API fetch capped or missed.

## 5. Task shape (additions to `ReviewTask`)

```jsonc
{
  // …existing fields…
  "languages": ["typescript", "solidity"],          // detected
  "instructions": {
    "review": "…", "skills": [ /* domain + second-opinion */ ],
    "languages": [ { "name": "typescript", "content": "…" }, … ]  // served language skills
  },
  "repoContext": [ { "path": "CLAUDE.md", "content": "…" }, { "path": ".claude/skills/foo/SKILL.md", "content": "…" } ]
}
```

## 6. Operations & gateway

- **Gateway additions:** `listPullFiles(repo, pr): Promise<string[]>` (changed paths, paginated `pulls.listFiles`); `getFileContent(repo, ref, path): Promise<string | null>` (contents API, decode base64, null on 404); `listDir(repo, ref, path): Promise<string[]>` (contents API on a dir, paths only, `[]` on 404).
- **`claim` changes:** after resolving domain skills, additionally (a) `detectLanguages(await listPullFiles(...))` → load each `skills/lang/<name>.md` into `instructions.languages`; (b) gather `repoContext` via the bounded fetch in §4. All best-effort: a failure to fetch context or files degrades to fewer items, never throws.
- Backward compatible: a PR touching no recognized language yields `languages: []`; a repo with no context files yields `repoContext: []`.

## 7. Skills

- **New language skills** under `skills/lang/<name>.md` (11 new + `rust` deepened; `rust` moves to `skills/lang/rust.md` or stays at `skills/rust.md` — the loader resolves both, see below). Each: a `# <Language> Review` heading + web-researched checklist (idioms, common defects, security pitfalls, concurrency/memory where relevant, tooling/linters).
- **Deepened domain skills:** `skills/security.md` (OWASP Top 10 2021, each category with what to look for), `skills/cryptography.md`, `skills/architecture.md`.
- **Loader:** `loadLanguageSkill(name, config)` resolves `skills/lang/<name>.md`. Language skills are kept in `LANGUAGE_NAMES` (separate from `SKILL_NAMES`, which remains the label-selected domain vocabulary). The docs embed script includes both lists.
- **`orchestration.md`:** add a "Load review context" section: languages are auto-served; domains come from labels; read the served `repoContext` AND the local checkout's `AGENT.md`/`AGENTS.md`/`CLAUDE.md`/`.claude/**`/`.codex/**` before reviewing, and prefer repo-specific conventions where they apply.

## 8. Docs

- A **Languages** page listing the detected languages + how detection works; the skills catalog auto-embeds language skills (embed script reads `LANGUAGE_NAMES` + `skills/lang/*.md`).
- Update the lifecycle/quick-start to mention pre-review context assembly. IO brand (no em dashes) throughout.

## 9. Testing

- `detectLanguages` (extension mapping, dedup, unknown ignored, only-bundled).
- Gateway additions on the fake (`listPullFiles`, `getFileContent`, `listDir`) + `claim` composing `languages`/`instructions.languages`/`repoContext` from seeded changed files + seeded repo files.
- Bounds: file cap + size cap on repo context; best-effort (missing files → skipped, no throw).
- Web-researched skill files are content (no unit tests) but are lint-checked for the `# <Name> Review` heading + non-empty; the docs build (onBrokenLinks) covers their embedding.

## 10. Acceptance criteria

- A PR's changed files auto-select the matching language skills in the claim task; unknown extensions are ignored; no language → `languages: []`.
- `security`/`cryptography`/`architecture` are rewritten with web-researched, authoritative content (OWASP Top 10 for security).
- 11 new language skills exist (+ `rust` deepened), each web-research-grounded.
- `claim` serves `repoContext` from the reviewed repo (bounded), and the orchestration skill reads the checkout as a supplement.
- Everything is best-effort: context/language loading never fails a claim.
- Docs (languages page + catalog) reflect the new skills; docs build clean; no em dashes.
- Single-reviewer and panel flows are unaffected except for the richer served context.

## 11. Out of scope

Deep recursive crawling of `.claude`/`.codex` (bounded shallow only); executing repo-local skills/hooks; non-GitHub context sources; per-language auto-running of linters (guidance only, subject to the existing `runChecks` posture).
