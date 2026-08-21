// Change classifier: maps a diff's changed file paths to a closed set of categories used by the
// safety gate (see gate.ts) to decide whether a change can even be considered for auto-merge. This
// module is pure and path-based only; it never looks at file contents, diff hunks, or git history.
//
// Conservative by default: every category below is a documented allowlist glob/predicate. A path
// that matches none of them, including one this module's author never anticipated, falls through
// to "source", the safe default. "source" and "test" always disqualify auto-eligibility; only a
// change confined entirely to docs/lint/ci/deps is auto-eligible. On top of that, two escape-to-
// source guards (below) keep executable code and CI-executing definitions out of docs/lint/ci
// regardless of where they live, so a path landing in the "right" directory is never enough on its
// own to make it auto-eligible; see EXECUTABLE_EXTS and WORKFLOW_OR_ACTION_DIR_RE.

import { LANGUAGE_EXTENSIONS } from "../languages.js";
import { LOCKFILE_NAMES } from "./dep-upgrade.js";

export type Category = "docs" | "lint" | "ci" | "deps" | "source" | "test";

export interface ChangeClassification {
  categories: Category[];
  autoEligible: boolean;
  sawSourceOrTest: boolean;
  byFile: Array<{ file: string; category: Category }>;
}

// Per-file evaluation order (most specific first): test, then the two escape-to-source guards
// (executable extension, workflow/action directory), then docs, ci, lint, deps, then the source
// fallback. `test` is checked before everything else so a file like `foo.test.ts` is classified as
// test, never source, even though `.ts` alone would otherwise escape to source. The escape guards
// run before docs/ci/lint so, for example, `docs/build.ts` and `.github/workflows/ci.yml` are
// source, not docs/ci, despite matching those directory rules.
//
// Extension checks are case-insensitive (`.MD` still counts as docs), matching the spec. Directory
// segments and exact filenames (`.github`, `docs`, `LICENSE`, lockfile names, lint config names)
// are matched with their conventional casing and are NOT case-folded.

// test: **/*.test.*, **/*.spec.*, or a path segment __tests__/, test/, or tests/.
// The *.test.* / *.spec.* check is a linear dot-segment scan (isTestFile below), not a regex, to
// avoid polynomial backtracking: file names come from the PR diff and are attacker-influenced.
const TEST_DIR_RE = /(^|\/)(__tests__|tests?)\//;

// A basename matches *.test.* / *.spec.* iff a dot-separated segment other than the first or last is
// exactly "test" or "spec" (case-insensitive). Linear in the path length; no backtracking. This
// matches the old /\.(test|spec)\.[^/]+$/i on every case (foo.test.ts and .test.ts are test;
// test.ts and foo.test are not, having no segment between two dots).
function isTestFile(file: string): boolean {
  const base = file.slice(file.lastIndexOf("/") + 1);
  const parts = base.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    const seg = parts[i].toLowerCase();
    if (seg === "test" || seg === "spec") return true;
  }
  return false;
}

// docs: **/*.md, **/*.mdx, anything under docs/, LICENSE, **/*.txt.
const DOCS_EXT_RE = /\.(md|mdx|txt)$/i;
const DOCS_DIR_RE = /(^|\/)docs\//;
const DOCS_LICENSE_RE = /(^|\/)LICENSE$/;

// ci: anything under .github/ (workflows and actions config).
const CI_DIR_RE = /(^|\/)\.github\//;

// lint: linter/formatter config only. Deliberately excludes tsconfig*.json: a tsconfig change
// affects compilation, not just formatting, so it is source (see the source fallback below).
const LINT_RE = /(^|\/)(\.eslintrc(\.[^/]+)?|eslint\.config\.[^/]+|\.prettierrc(\.[^/]+)?|\.prettierignore|\.editorconfig)$/;

// deps: lockfiles only, at any depth (root or nested in a workspace). `package.json` is
// intentionally NOT matched here: a path alone cannot tell a dependency bump from a script or
// config edit inside package.json, so it falls through to source. A real bot-authored,
// semver-only bump is a separate gate input, computed elsewhere from the diff content, not the
// path. The basename lookup uses the content classifier's exported allowlist, so teaching either
// operation a new lockfile necessarily teaches both and keeps this attacker-influenced path scan
// linear.
function isLockfile(file: string): boolean {
  return LOCKFILE_NAMES.has(file.slice(file.lastIndexOf("/") + 1));
}

// Escape-to-source guard (a): executable code is source, full stop, regardless of directory. A
// path alone is not proof of intent; a `.ts`/`.js`/`.sh`/etc. file under docs/, .github/, or next
// to a lint config name is still code, so it must not be classified as docs/ci/lint. This is
// checked before the docs/lint/ci/deps rules below, so it overrides them.
//
// EXECUTABLE_EXTS is the union of every language core/languages.ts already recognizes as source
// (reused here as the single source of truth, so a language added there is automatically treated
// as executable here too, with no separate list to keep in sync) plus common scripting-language
// extensions that languages.ts does not track.
const EXECUTABLE_EXTS: ReadonlySet<string> = new Set([
  ...Object.values(LANGUAGE_EXTENSIONS).flat(),
  ".sh", ".bash", ".zsh", ".rb", ".php", ".pl", ".ps1", ".psm1",
]);

function hasExecutableExt(file: string): boolean {
  const lower = file.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 && EXECUTABLE_EXTS.has(lower.slice(dot));
}

// Escape-to-source guard (b): a workflow or composite-action definition executes in CI with
// repository secrets, even though it is YAML, not a recognized "executable" extension above. Any
// file under .github/workflows/ or .github/actions/ is source, never auto, regardless of
// extension. This deliberately narrows the "ci" category to non-executing GitHub config only
// (e.g. dependabot.yml, CODEOWNERS, issue/PR templates); workflow and action edits always require
// full review.
const WORKFLOW_OR_ACTION_DIR_RE = /(^|\/)\.github\/(workflows|actions)\//;

const AUTO_CATEGORIES: ReadonlySet<Category> = new Set(["docs", "lint", "ci", "deps"]);

// Fixed display order for the `categories` summary, independent of per-file evaluation order or
// input order. Keeps the field deterministic and readable (e.g. in a proposal comment).
const CATEGORY_ORDER: Category[] = ["docs", "lint", "ci", "deps", "source", "test"];

function classifyFile(file: string): Category {
  if (isTestFile(file) || TEST_DIR_RE.test(file)) return "test";
  if (hasExecutableExt(file)) return "source"; // guard (a): executable code, wherever it lives
  if (WORKFLOW_OR_ACTION_DIR_RE.test(file)) return "source"; // guard (b): CI-executing definitions
  if (DOCS_EXT_RE.test(file) || DOCS_DIR_RE.test(file) || DOCS_LICENSE_RE.test(file)) return "docs";
  if (CI_DIR_RE.test(file)) return "ci";
  if (LINT_RE.test(file)) return "lint";
  if (isLockfile(file)) return "deps";
  return "source"; // the conservative default: anything unrecognized is source
}

export function classifyChange(files: string[]): ChangeClassification {
  const byFile = files.map((file) => ({ file, category: classifyFile(file) }));
  const present = new Set(byFile.map((f) => f.category));
  const categories = CATEGORY_ORDER.filter((c) => present.has(c));
  const sawSourceOrTest = byFile.some((f) => f.category === "source" || f.category === "test");
  // Written as the explicit allowlist check plus the sawSourceOrTest check (rather than relying on
  // just one of the two, even though today they are equivalent) so this stays conservative if
  // Category ever grows a new value that isn't threaded through both places.
  const autoEligible = files.length > 0 && byFile.every((f) => AUTO_CATEGORIES.has(f.category)) && !sawSourceOrTest;
  return { categories, autoEligible, sawSourceOrTest, byFile };
}
