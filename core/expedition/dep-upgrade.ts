// Content-verified dependency-upgrade classifier: decides whether a diff is nothing but a
// dependency version bump (lockfiles, plus `package.json` patches that change only version
// strings) and, if so, how big the semver jump is. Pure: no I/O, no clock, no randomness.
//
// This is the one place in the expedition code that looks at diff CONTENT rather than paths.
// classify.ts deliberately treats `package.json` as source, because a path alone cannot tell a
// version bump from a `scripts` edit. This module answers the question the path cannot, and it is
// STRICTER than the path rule: every changed line in a manifest must be a paired -/+ dependency
// version line, or the whole change is ineligible.
//
// Every parser below is a linear scan (indexOf/charCodeAt, no backtracking regexes): file names
// and patch bodies come straight from a pull request and are attacker-influenced.

import type { DetailedPullFile } from "../github.js";

export type SemverLevel = "patch" | "minor" | "major" | "unknown";

export interface DependencyUpgrade {
  /** Every changed file is a lockfile or a version-only `package.json` patch, and there is at least one. */
  eligibleShape: boolean;
  /** The diff touches lockfiles only (no manifest to read a package name or version out of). */
  lockfilesOnly: boolean;
  /** Paths of the changed `package.json` files, in diff order. */
  manifests: string[];
  changedPackages: Array<{ name: string; from: string; to: string }>;
  semverLevel: SemverLevel;
  /**
   * Paths that made `eligibleShape` false, so a caller can name them in a rejection reason.
   * Empty when `eligibleShape` is true. (Additive to the shape a caller strictly needs; without
   * it every caller would have to re-run this module's file and patch checks to explain itself.)
   */
  ineligibleFiles: string[];
}

// The one lockfile-name allowlist for both this content-aware classifier and classify.ts's path
// classifier. Exported because adding a name on only this side is unsafe: the steward synthesizes an
// auto-eligible dependency classification after this stricter check passes, so both entry points
// must recognize exactly the same basenames. Matched at any workspace depth.
export const LOCKFILE_NAMES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
]);
const MANIFEST = "package.json";

// The only file statuses a dependency bump produces. "removed", "renamed", and "copied" all change
// which files exist, not just which versions they pin, and a deleted lockfile in particular would
// otherwise sail through on its name alone since nothing else about a lockfile is inspected. Any
// unrecognized future status is rejected too.
const UPGRADE_STATUSES: ReadonlySet<string> = new Set(["modified", "added"]);

// Top-level `package.json` keys whose values are strings but are NOT dependency versions. A change
// to one of them makes the shape ineligible. This module reads changed LINES, not the JSON tree, so
// it cannot see which object a line belongs to; without this guard a release commit rewriting
// `"version": "0.4.0"` would read as a minor bump of a package called "version". A real dependency
// that happens to share one of these names is rejected too, which is the safe direction: the change
// goes to a human instead of through the auto path.
//
// Known and accepted limitation: entries of `engines`, `overrides`, and `resolutions` are
// indistinguishable from dependency entries at line level. For overrides/resolutions that is
// correct (they are pinned dependency versions); an `engines` bump would be misread as a
// dependency bump. The bot-author allowlist in approveDependencyUpgrade is what keeps that from
// mattering: the bots on it do not rewrite `engines`.
const RESERVED_MANIFEST_KEYS: ReadonlySet<string> = new Set([
  "name", "version", "description", "homepage", "license", "main", "module", "browser",
  "types", "typings", "bin", "man", "author", "type", "packageManager", "repository",
  "funding", "private",
]);

const basename = (file: string): string => file.slice(file.lastIndexOf("/") + 1);

/**
 * Parse one JSON object entry of the form `"name": "value"`, with an optional trailing comma and
 * any surrounding whitespace. Returns null for anything else, including a line holding an object,
 * an array, a number, a boolean, or more than one entry. Linear in the line length.
 */
function parseEntryLine(raw: string): { key: string; value: string } | null {
  const line = raw.trim();
  const body = line.endsWith(",") ? line.slice(0, -1).trimEnd() : line;
  if (!body.startsWith("\"")) return null;
  const keyEnd = body.indexOf("\"", 1);
  if (keyEnd < 0) return null;
  const key = body.slice(1, keyEnd);
  let i = keyEnd + 1;
  while (i < body.length && (body[i] === " " || body[i] === "\t")) i++;
  if (body[i] !== ":") return null;
  i++;
  while (i < body.length && (body[i] === " " || body[i] === "\t")) i++;
  if (body[i] !== "\"") return null;
  const valueStart = i + 1;
  const valueEnd = body.indexOf("\"", valueStart);
  // The closing quote must be the last character: anything trailing it (a second entry, a stray
  // brace, a comment) means this is not a plain one-entry line.
  if (valueEnd < 0 || valueEnd !== body.length - 1) return null;
  const value = body.slice(valueStart, valueEnd);
  if (key.length === 0 || value.length === 0) return null;
  return { key, value };
}

/**
 * Walk a unified diff patch and collect the dependency version changes it makes, or return null if
 * the patch contains ANY other added or removed content.
 *
 * The patch is read as a sequence of change blocks: a run of removed lines followed by a run of
 * added lines, delimited by context lines and hunk headers. A block is accepted only when it holds
 * equally many removals and additions and each positional pair changes the value of the same
 * (non-reserved) key. Single-pass and allocation-bounded; nothing here backtracks.
 *
 * GitHub's `patch` field starts at the first `@@` hunk header and carries no `---`/`+++` file
 * headers; if one ever appeared it would read as an ordinary added/removed line and correctly make
 * the patch ineligible.
 */
function parseVersionOnlyPatch(patch: string): Array<{ name: string; from: string; to: string }> | null {
  const changes: Array<{ name: string; from: string; to: string }> = [];
  let removals: string[] = [];
  let additions: string[] = [];

  const flush = (): boolean => {
    if (removals.length === 0 && additions.length === 0) return true;
    if (removals.length !== additions.length) return false;
    for (let i = 0; i < removals.length; i++) {
      const before = parseEntryLine(removals[i]);
      const after = parseEntryLine(additions[i]);
      if (!before || !after) return false;
      if (before.key !== after.key) return false;
      if (RESERVED_MANIFEST_KEYS.has(before.key)) return false;
      changes.push({ name: before.key, from: before.value, to: after.value });
    }
    removals = [];
    additions = [];
    return true;
  };

  for (const line of patch.split("\n")) {
    if (line.startsWith("+")) { additions.push(line.slice(1)); continue; }
    if (line.startsWith("-")) {
      // A removal after an addition starts a new block: within one unified-diff block every
      // removal precedes every addition.
      if (additions.length > 0 && !flush()) return null;
      removals.push(line.slice(1));
      continue;
    }
    // Context line, hunk header, or "\ No newline at end of file": ends the current block.
    if (!flush()) return null;
  }
  return flush() ? changes : null;
}

// Leading characters an npm range can put in front of a version, plus an optional "v". Stripped so
// "^1.2.3" and "1.2.3" compare the same way. A range this simple strip cannot reduce to a bare
// x.y.z (">=1.0.0 <2.0.0", "1.x", "1.2.3 || 2.0.0") falls out as unparseable below.
const RANGE_PREFIX: ReadonlySet<string> = new Set(["^", "~", ">", "<", "=", " ", "\t", "v", "V"]);

/** Parse a bare dotted x.y.z after stripping a leading range operator. Null for anything else. */
function parseVersion(raw: string): [number, number, number] | null {
  let i = 0;
  while (i < raw.length && RANGE_PREFIX.has(raw[i])) i++;
  const parts = raw.slice(i).split(".");
  if (parts.length !== 3) return null;
  const nums: number[] = [];
  for (const part of parts) {
    // Digits only: this is what rejects prereleases ("1.2.3-beta"), build metadata ("1.2.3+sha"),
    // and wildcards ("1.2.x"). Bounded length keeps the parse away from precision loss.
    if (part.length === 0 || part.length > 9) return null;
    for (let k = 0; k < part.length; k++) {
      const code = part.charCodeAt(k);
      if (code < 48 || code > 57) return null;
    }
    nums.push(Number(part));
  }
  return [nums[0], nums[1], nums[2]];
}

// The size of one version jump. "none" means the two versions are equal, which contributes nothing
// to the maximum. Direction is not considered: a downgrade is classified by the component that
// differs, so a rollback across a major boundary is still "major".
function jumpLevel(from: string, to: string): SemverLevel | "none" {
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (!a || !b) return "unknown";
  if (a[0] !== b[0]) return "major";
  if (a[1] !== b[1]) return "minor";
  if (a[2] !== b[2]) return "patch";
  return "none";
}

function maxSemverLevel(changes: Array<{ from: string; to: string }>): SemverLevel {
  // No parseable jump at all (a lockfile-only diff, or manifest lines whose versions did not
  // actually move) is "unknown", not "patch": there is no evidence of how large the upgrade is,
  // and callers reject "unknown". Fail closed.
  if (changes.length === 0) return "unknown";
  let level: SemverLevel | "none" = "none";
  for (const c of changes) {
    const jump = jumpLevel(c.from, c.to);
    if (jump === "unknown") return "unknown"; // one unparseable version poisons the whole answer
    if (jump === "major") level = "major";
    else if (jump === "minor" && level !== "major") level = "minor";
    else if (jump === "patch" && level === "none") level = "patch";
  }
  return level === "none" ? "unknown" : level;
}

/**
 * Classify a pull request's files as a dependency upgrade.
 *
 * `eligibleShape` is true only when there is at least one changed file and every changed file is
 * either a lockfile or a `package.json` whose patch changes nothing but dependency version
 * strings. A manifest with no `patch` at all (too large for GitHub to inline, or a rename) is
 * ineligible: an unreadable patch is not a verified one.
 */
export function classifyDependencyUpgrade(files: DetailedPullFile[]): DependencyUpgrade {
  const manifests: string[] = [];
  const ineligibleFiles: string[] = [];
  const changedPackages: Array<{ name: string; from: string; to: string }> = [];
  let lockfileCount = 0;

  for (const file of files) {
    const base = basename(file.filename);
    const recognized = LOCKFILE_NAMES.has(base) || base === MANIFEST;
    // Checked before anything else so a lockfile, whose contents are never inspected, cannot be
    // deleted or renamed under cover of its name.
    if (recognized && !UPGRADE_STATUSES.has(file.status)) { ineligibleFiles.push(file.filename); continue; }
    if (LOCKFILE_NAMES.has(base)) { lockfileCount++; continue; }
    if (base !== MANIFEST) { ineligibleFiles.push(file.filename); continue; }
    manifests.push(file.filename);
    if (file.patch === undefined || file.patch === "") { ineligibleFiles.push(file.filename); continue; }
    const changes = parseVersionOnlyPatch(file.patch);
    if (changes === null) { ineligibleFiles.push(file.filename); continue; }
    changedPackages.push(...changes);
  }

  const eligibleShape = files.length > 0 && ineligibleFiles.length === 0;
  return {
    eligibleShape,
    lockfilesOnly: files.length > 0 && lockfileCount === files.length,
    manifests,
    changedPackages,
    // Only meaningful for an eligible shape; an ineligible diff reports "unknown" rather than a
    // level derived from the subset of lines that happened to parse.
    semverLevel: eligibleShape ? maxSemverLevel(changedPackages) : "unknown",
    ineligibleFiles,
  };
}
