# Review Context Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Auto-load the best review context at `claim` time: language skills (auto-detected from changed files), deepened domain skills, and the reviewed repo's own context (`AGENT.md`/`.claude`/`.codex`). Extends the panel branch.

**Architecture:** New `core/languages.ts` (extension→language detection) and `core/repo-context.ts` (bounded fetch of the reviewed repo's agent files). Three new read methods on `GitHubGateway`. `claim` composes `languages` + `instructions.languages` + `repoContext` into the served `ReviewTask`, all best-effort (never fails a claim). Language skills live in `skills/lang/*.md`, web-research-grounded; `security`/`cryptography`/`architecture` are deepened.

**Tech Stack:** unchanged.

## Global Constraints

- Base + panel Global Constraints still hold (ESM `.js`, NodeNext, strict, GPG+DCO `git commit -S -s`, no manual Signed-off-by).
- **Language set (12):** `typescript, javascript, python, go, rust, haskell, java, kotlin, swift, scala, c-cpp, solidity`. Extension map is §3 of the spec. `rust` becomes a LANGUAGE (moves to `skills/lang/rust.md`, removed from `SKILL_NAMES`); `react-native` stays a label-selected domain/framework skill.
- **Language skills** live in `skills/lang/<name>.md`; kept in `LANGUAGE_NAMES` (separate from `SKILL_NAMES`). Selected by AUTO-DETECTION from changed files, not labels.
- **Local-repo context** fetched by `claim` at the pinned SHA, bounded: exact files `AGENT.md, AGENTS.md, CLAUDE.md, .claude/CLAUDE.md` + shallow `.md` from dirs `.claude`, `.codex`, `.claude/skills` (recurse one level for `SKILL.md`), **file cap 10, total size cap 65536 bytes**. Missing paths skipped; never throws.
- **Everything context-related is best-effort:** any fetch/detect failure degrades to fewer items; `claim` must still succeed.
- **Docs are IO-branded:** NO em dashes; American English.
- Web-researched skills must cite/ground in authoritative sources (style guides, OWASP, CVE/common-bug patterns) and follow the `# <Name> Review` house style.

---

## File Structure

```text
core/languages.ts       LANGUAGE_EXTENSIONS, LANGUAGE_NAMES, detectLanguages
core/repo-context.ts    gatherRepoContext (bounded, best-effort)
core/github.ts          + listPullFiles, getFileContent, listDir
core/skills.ts          + hasLanguageSkill, loadLanguageSkill, composeLanguages
core/labels.ts          remove "rust" from SKILL_NAMES
core/model.ts           ReviewTask += languages, instructions.languages, repoContext
core/operations/claim.ts  compose languages + repoContext (best-effort)
core/index.ts           export new modules/fns
test/fakes/fake-github.ts + files/fileContents/dirs stores + the 3 methods
skills/lang/*.md        12 language skills (web-researched); rust moved here
skills/{security,cryptography,architecture}.md  deepened (web-researched)
skills/orchestration.md  "Load review context" section
docs/scripts/embed-sources.mjs  include LANGUAGE_NAMES + skills/lang/*.md
docs/languages.md       new page; docs/sidebars.ts entry; quick-start/lifecycle note
```

---

### Task 1: `core/languages.ts` — detection

**Files:** Create `core/languages.ts`, `core/languages.test.ts`.

- [ ] **Step 1: Failing test**
```ts
// core/languages.test.ts
import { describe, it, expect } from "vitest";
import { detectLanguages, LANGUAGE_NAMES } from "./languages.js";
describe("detectLanguages", () => {
  it("maps extensions to languages, dedups, sorts, ignores unknown", () => {
    expect(detectLanguages(["src/a.ts", "src/b.tsx", "x.sol", "y.unknown", "Makefile"]))
      .toEqual(["solidity", "typescript"]);
  });
  it("covers the 12-language set", () => {
    expect(LANGUAGE_NAMES).toEqual(expect.arrayContaining(["typescript","javascript","python","go","rust","haskell","java","kotlin","swift","scala","c-cpp","solidity"]));
    expect(LANGUAGE_NAMES).toHaveLength(12);
  });
  it("detects c-cpp from both C and C++ extensions", () => {
    expect(detectLanguages(["a.c", "b.hpp"])).toEqual(["c-cpp"]);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `core/languages.ts`**
```ts
export const LANGUAGE_EXTENSIONS: Record<string, string[]> = {
  typescript: [".ts", ".tsx", ".mts", ".cts"],
  javascript: [".js", ".jsx", ".mjs", ".cjs"],
  python: [".py", ".pyi"],
  go: [".go"],
  rust: [".rs"],
  haskell: [".hs", ".lhs"],
  java: [".java"],
  kotlin: [".kt", ".kts"],
  swift: [".swift"],
  scala: [".scala", ".sc"],
  "c-cpp": [".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
  solidity: [".sol"],
};
export const LANGUAGE_NAMES = Object.keys(LANGUAGE_EXTENSIONS);
const EXT_TO_LANG: Record<string, string> = Object.fromEntries(
  Object.entries(LANGUAGE_EXTENSIONS).flatMap(([lang, exts]) => exts.map((e) => [e, lang])),
);
export function detectLanguages(files: string[]): string[] {
  const found = new Set<string>();
  for (const f of files) {
    const dot = f.lastIndexOf(".");
    if (dot < 0) continue;
    const lang = EXT_TO_LANG[f.slice(dot).toLowerCase()];
    if (lang) found.add(lang);
  }
  return [...found].sort();
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(core): language detection from changed files`.

---

### Task 2: Gateway — `listPullFiles`, `getFileContent`, `listDir`

**Files:** Modify `core/github.ts`, `test/fakes/fake-github.ts`, `test/fakes/fake-github.test.ts`.

**Interfaces:** add to `GitHubGateway`:
```ts
listPullFiles(repo: string, pr: number): Promise<string[]>;
getFileContent(repo: string, ref: string, path: string): Promise<string | null>;
listDir(repo: string, ref: string, path: string): Promise<string[]>;
```

- [ ] **Step 1: Extend the fake + failing test.** Add fake stores: `pullFiles = new Map<string,string[]>()` (key `repo#pr`), `fileContents = new Map<string,string>()` (key `repo@ref:path`), `dirs = new Map<string,string[]>()` (key `repo@ref:path`), with seeders `seedPullFiles(repo,pr,paths)`, `seedFile(repo,ref,path,content)`, `seedDir(repo,ref,path,paths)`. Implement:
```ts
async listPullFiles(repo, pr) { return this.pullFiles.get(`${repo}#${pr}`) ?? []; }
async getFileContent(repo, ref, path) { return this.fileContents.get(`${repo}@${ref}:${path}`) ?? null; }
async listDir(repo, ref, path) { return this.dirs.get(`${repo}@${ref}:${path}`) ?? []; }
```
Test: seed pull files + a file + a dir, assert the three methods read them back and return `[]`/`null` for missing.

- [ ] **Step 2: Run → FAIL** (methods not on interface).

- [ ] **Step 3: Implement in `core/github.ts` `OctokitGateway`:**
```ts
async listPullFiles(repo: string, pr: number): Promise<string[]> {
  const [owner, name] = split(repo);
  const items = await this.kit.paginate(this.kit.pulls.listFiles, { owner, repo: name, pull_number: pr, per_page: 100 });
  return items.map((f) => f.filename);
}
async getFileContent(repo: string, ref: string, path: string): Promise<string | null> {
  const [owner, name] = split(repo);
  try {
    const { data } = await this.kit.repos.getContent({ owner, repo: name, path, ref });
    if (!Array.isArray(data) && data.type === "file" && typeof data.content === "string") {
      return Buffer.from(data.content, "base64").toString("utf8");
    }
    return null;
  } catch (e: any) { if (e.status === 404) return null; throw e; }
}
async listDir(repo: string, ref: string, path: string): Promise<string[]> {
  const [owner, name] = split(repo);
  try {
    const { data } = await this.kit.repos.getContent({ owner, repo: name, path, ref });
    return Array.isArray(data) ? data.map((d) => d.path) : [];
  } catch (e: any) { if (e.status === 404) return []; throw e; }
}
```

- [ ] **Step 4: Run → PASS**; `npm run typecheck` clean; `npm test` green (pretest gate confirms the fake still implements the interface).
- [ ] **Step 5: Commit** `feat(core): gateway listPullFiles/getFileContent/listDir (+ fake)`.

---

### Task 3: Skills loader for languages + move `rust`, trim `SKILL_NAMES`

**Files:** Modify `core/skills.ts`, `core/labels.ts`, `core/labels.test.ts`; move `skills/rust.md` → `skills/lang/rust.md`; create `core/skills.test.ts` cases.

- [ ] **Step 1:** In `core/labels.ts`, remove `"rust"` from `SKILL_NAMES` (rust is now a detected language). Update `core/labels.test.ts`: any assertion using `"rust"` as a domain skill switches to another domain name (e.g. `"react-native"` or `"security"`); the composeRequestLabels/parseSkills examples that used `rust` use `security` instead. (Keep the tests meaningful.)

- [ ] **Step 2:** `git mv skills/rust.md skills/lang/rust.md` (content deepened later in Task 6).

- [ ] **Step 3:** Add to `core/skills.ts`:
```ts
const langPath = (name: string, config: Config): string => path.join(skillsRoot(config), "lang", `${name}.md`);
export function hasLanguageSkill(name: string, config: Config): boolean { return existsSync(langPath(name, config)); }
export function loadLanguageSkill(name: string, config: Config): string { return readFileSync(langPath(name, config), "utf8"); }
export function composeLanguages(names: string[], config: Config): Array<{ name: string; content: string }> {
  return names.filter((n) => hasLanguageSkill(n, config)).map((n) => ({ name: n, content: loadLanguageSkill(n, config) }));
}
```

- [ ] **Step 4:** Add a `core/skills.test.ts` case: with a temp skillsDir containing `lang/rust.md` + `lang/go.md`, `composeLanguages(["rust","go","nope"], cfg)` returns rust+go (nope dropped, missing file ignored).

- [ ] **Step 5:** Run focused tests → PASS; `npm test` green.
- [ ] **Step 6: Commit** `feat(core): language skill loader; rust becomes a detected language`.

---

### Task 4: `core/repo-context.ts` — bounded local-repo fetch

**Files:** Create `core/repo-context.ts`, `core/repo-context.test.ts`.

**Interface:** `gatherRepoContext(gh: GitHubGateway, repo: string, ref: string): Promise<Array<{ path: string; content: string }>>` (best-effort; obeys the caps in Global Constraints).

- [ ] **Step 1: Failing test** (uses the fake, seeded files + a `.claude` dir):
```ts
// core/repo-context.test.ts
import { describe, it, expect } from "vitest";
import { FakeGitHubGateway } from "../test/fakes/fake-github.js";
import { gatherRepoContext } from "./repo-context.js";
describe("gatherRepoContext", () => {
  it("collects exact files + shallow .claude md, skips missing, respects order", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedFile("o/r", "sha", "CLAUDE.md", "root claude");
    gh.seedFile("o/r", "sha", ".claude/CLAUDE.md", "dot claude");
    gh.seedDir("o/r", "sha", ".claude", [".claude/CLAUDE.md", ".claude/notes.md", ".claude/x.txt"]);
    gh.seedFile("o/r", "sha", ".claude/notes.md", "notes");
    const ctx = await gatherRepoContext(gh, "o/r", "sha");
    const paths = ctx.map((c) => c.path);
    expect(paths).toContain("CLAUDE.md");
    expect(paths).toContain(".claude/notes.md");
    expect(paths).not.toContain(".claude/x.txt"); // non-md excluded
    expect(ctx.find((c) => c.path === "AGENT.md")).toBeUndefined(); // missing skipped
  });
  it("returns [] when nothing exists (best-effort, no throw)", async () => {
    expect(await gatherRepoContext(new FakeGitHubGateway(), "o/r", "sha")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `core/repo-context.ts`:**
```ts
import type { GitHubGateway } from "./github.js";

const EXACT = ["AGENT.md", "AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md"];
const DIRS = [".claude", ".codex", ".claude/skills"];
const FILE_CAP = 10;
const SIZE_CAP = 65536;

export async function gatherRepoContext(
  gh: GitHubGateway, repo: string, ref: string,
): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = [];
  const seen = new Set<string>();
  let total = 0;
  const add = async (path: string) => {
    if (seen.has(path) || out.length >= FILE_CAP) return;
    seen.add(path);
    let content: string | null = null;
    try { content = await gh.getFileContent(repo, ref, path); } catch { return; }
    if (content == null) return;
    if (total + content.length > SIZE_CAP) return;
    total += content.length;
    out.push({ path, content });
  };
  for (const p of EXACT) { if (out.length >= FILE_CAP) break; await add(p); }
  for (const dir of DIRS) {
    if (out.length >= FILE_CAP) break;
    let entries: string[] = [];
    try { entries = await gh.listDir(repo, ref, dir); } catch { entries = []; }
    for (const e of entries) {
      if (out.length >= FILE_CAP) break;
      if (e.toLowerCase().endsWith(".md")) await add(e);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(core): bounded best-effort repo-context fetch`.

---

### Task 5: `claim` integration + `ReviewTask` additions + barrel

**Files:** Modify `core/model.ts`, `core/operations/claim.ts`, `core/operations/claim.test.ts`, `core/index.ts`.

- [ ] **Step 1:** In `core/model.ts`, extend `ReviewTask`: add `languages: string[];`, add `languages: Array<{ name: string; content: string }>;` to the `instructions` object type, and add `repoContext: Array<{ path: string; content: string }>;`.

- [ ] **Step 2:** Update `core/operations/claim.test.ts`: seed changed files (`gh.seedPullFiles("o/r", 5, ["a.ts","b.sol"])`) + a repo-context file (`gh.seedFile("o/r","deadbeef","CLAUDE.md","x")`) + a temp skillsDir with `lang/typescript.md`, `lang/solidity.md`. Assert the claim task has `languages` = `["solidity","typescript"]`, `instructions.languages` names match, and `repoContext` includes `CLAUDE.md`. Keep existing role/skill assertions.

- [ ] **Step 3:** In `core/operations/claim.ts`, after building `instructions`, add (best-effort):
```ts
import { detectLanguages } from "../languages.js";
import { composeLanguages } from "../skills.js";
import { gatherRepoContext } from "../repo-context.js";
// …after instructions is built and second-opinion appended…
let languages: string[] = [];
try { languages = detectLanguages(await gh.listPullFiles(opts.repo, opts.pr)); } catch { languages = []; }
const instructionsWithLangs = { ...instructions, languages: composeLanguages(languages, config) };
let repoContext: Array<{ path: string; content: string }> = [];
try { repoContext = await gatherRepoContext(gh, opts.repo, pinnedSha); } catch { repoContext = []; }
return {
  // …existing fields…, 
  languages,
  instructions: instructionsWithLangs,
  repoContext,
  // claim: { machine, claimedAt: now },
};
```
(Integrate cleanly with the existing return object; `instructions` gains a `languages` array; do not drop existing fields.)

- [ ] **Step 4:** `core/index.ts`: `export * from "./languages.js"; export * from "./repo-context.js";` (skills/labels already exported).

- [ ] **Step 5:** Run `npx vitest run core/operations/claim.test.ts` → PASS; `npm run typecheck` clean; `npm test` green.
- [ ] **Step 6: Commit** `feat(core): claim serves detected languages + repo context`.

---

### Task 6: Language skills content (web-researched) — 12 files

**Files:** Create/overwrite `skills/lang/{typescript,javascript,python,go,rust,haskell,java,kotlin,swift,scala,c-cpp,solidity}.md`.

- [ ] **Step 1:** For EACH language, use web search to ground the content in authoritative sources (the language's official style guide, common bug/vulnerability patterns, idioms, and standard linters/tooling). Then write `skills/lang/<name>.md` as `# <Language> Review` + a focused, specific checklist (correctness/idioms, common defects, security pitfalls, concurrency/memory where relevant, tooling). Keep each concise (a tight checklist, not an essay). No em dashes. Cite the key source(s) inline where useful.
  - Coverage notes: `solidity` → reentrancy, checks-effects-interactions, integer overflow/underflow, access control, gas/DoS, oracle/price manipulation (ground in the SWC registry / current Solidity security guidance). `c-cpp` → memory safety (bounds, use-after-free, leaks), UB, RAII/ownership, integer overflow, `-Wall`/sanitizers/clang-tidy. `haskell` → totality, laziness/space leaks, `Maybe`/`Either`, effect handling, `hlint`. `go` → error handling, goroutine/leak/race, `context`, `go vet`/`staticcheck`. `rust` → ownership/borrows, `unsafe`, `Result`/`?`, `clippy`. (Etc. per language.)
- [ ] **Step 2:** Verify each file exists with the heading + non-empty checklist; `node dist/cli/index.js` loader check (after Task 8 wiring) or a direct `composeLanguages` node check shows all 12 resolve.
- [ ] **Step 3: Commit** `docs(skills): 12 web-researched language review skills`.

> Execution note for the controller: these 12 are independent content files. Author them via research-and-author subagents that WRITE files (no commit), then batch-commit + batch-review, to avoid git-index contention.

---

### Task 7: Deepen domain skills (web-researched)

**Files:** Overwrite `skills/security.md`, `skills/cryptography.md`, `skills/architecture.md`.

- [ ] **Step 1:** `security.md` → rewrite around the **OWASP Top 10 (2021)**: one bullet per category (A01 Broken Access Control … A10 SSRF) with concrete "what to look for in a diff." Ground in the current OWASP Top 10.
- [ ] **Step 2:** `cryptography.md` → deepen with current best practices (vetted primitives, AEAD, nonce/IV uniqueness, KDFs/password hashing, constant-time, key management, no homegrown crypto), grounded in authoritative guidance.
- [ ] **Step 3:** `architecture.md` → deepen (boundaries/coupling/cohesion, dependency direction, YAGNI, change-locality, testability), grounded in recognized principles.
- [ ] **Step 4:** Keep the `# <Name> Review` house style; no em dashes; concise. Verify headings + non-empty.
- [ ] **Step 5: Commit** `docs(skills): deepen security (OWASP Top 10), cryptography, architecture`.

---

### Task 8: Orchestration + docs + embed wiring + final gate

**Files:** Modify `skills/orchestration.md`, `docs/scripts/embed-sources.mjs`, `docs/sidebars.ts`, `docs/quick-start.md`, `docs/lifecycle.md`; create `docs/languages.md`.

- [ ] **Step 1:** `skills/orchestration.md` — add a "Load review context" section: before reviewing, the served task carries `instructions.languages` (auto-detected) and `repoContext`; ALSO read the checkout's `AGENT.md`/`AGENTS.md`/`CLAUDE.md`/`.claude/**`/`.codex/**` as a supplement, and prefer repo-specific conventions where they apply. No em dashes.
- [ ] **Step 2:** `docs/scripts/embed-sources.mjs` — the skills catalog must also include language skills: read `LANGUAGE_NAMES` (parse from `core/languages.ts`, mirroring how it already parses `SKILL_NAMES`) and embed `skills/lang/<name>.md` for each under a "Language skills" subsection. Verify `second-opinion`-style auto-embedding still works.
- [ ] **Step 3:** Create `docs/languages.md` — list the 12 languages + extension map + how auto-detection works; add to `docs/sidebars.ts`. Add a short note to `docs/quick-start.md`/`docs/lifecycle.md` that the reviewer auto-loads language + repo context. No em dashes.
- [ ] **Step 4: Final gate:** from repo root `npm run typecheck && npm run check:schemas && npm test && npm run build` all green; `cd docs && npm run build` clean (onBrokenLinks throw; language skills + languages page embedded); `grep -rn '—' docs/languages.md skills/lang/*.md skills/security.md skills/cryptography.md skills/architecture.md skills/orchestration.md` returns nothing.
- [ ] **Step 5: Commit** `docs(site): languages page + orchestration context-loading + catalog embed`.

---

## Self-Review (during planning)

- **Spec coverage:** detection (T1) ✓; gateway reads (T2) ✓; language loader + rust move (T3) ✓; bounded repo-context (T4) ✓; claim integration + task shape (T5) ✓; 12 web-researched language skills (T6) ✓; deepened OWASP/crypto/architecture (T7) ✓; orchestration + docs + embed (T8) ✓; best-effort everywhere (T4/T5 try/catch) ✓; auto-detect not label (T5) ✓; local-repo both (T4 API fetch + T8 checkout-read instruction) ✓.
- **Type consistency:** `detectLanguages`/`LANGUAGE_NAMES` (T1) used by T5; gateway methods (T2) used by T4/T5; `composeLanguages` (T3) used by T5; `gatherRepoContext` (T4) used by T5; `ReviewTask` additions (T5) consumed by CLI/MCP already (they JSON-print the task, no shape assumptions) and by the orchestration skill (T8).
- **Churn note:** removing `rust` from `SKILL_NAMES` requires updating `labels.test.ts` (T3); `docs/labels.md`/catalog reflect rust-as-language via the embed update (T8).
- **No placeholders** in T1-T5 (real code); T6-T7 are web-research content tasks (author to the template), T8 is docs/wiring.
