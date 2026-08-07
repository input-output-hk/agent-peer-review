import semver from "semver";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type SpotKind = "version" | "range";

export interface Spot {
  file: string;
  label: string;
  /** A regex whose first capture group is the semantic version (a `range` spot
   *  captures the version after its leading `^`). Applied to the first match only. */
  pattern: RegExp;
  kind: SpotKind;
}

/**
 * Every place the release version is written. The two packages are versioned in
 * lockstep, so all of these must always agree with the root package version.
 *
 * The patterns assume the current single-line formatting of these lines. If one
 * is ever reformatted (a key reordered, or split across lines), update its
 * pattern here; `check:version` in CI fails loudly on a spot it can no longer
 * find, so such a change surfaces rather than silently slipping through.
 */
export const SPOTS: Spot[] = [
  { file: "package.json", label: "root package version", pattern: /"version":\s*"([^"]+)"/, kind: "version" },
  { file: "pi/package.json", label: "pi package version", pattern: /"version":\s*"([^"]+)"/, kind: "version" },
  { file: "pi/package.json", label: "pi -> core dependency", pattern: /"@input-output-hk\/agent-review":\s*"\^([^"]+)"/, kind: "range" },
  { file: "dashboard/package.json", label: "dashboard package version", pattern: /"version":\s*"([^"]+)"/, kind: "version" },
  { file: "dashboard/package.json", label: "dashboard -> core dependency", pattern: /"@input-output-hk\/agent-review":\s*"\^([^"]+)"/, kind: "range" },
  { file: "cli/index.ts", label: "cli --version", pattern: /\.version\("([^"]+)"\)/, kind: "version" },
  { file: "mcp/server.ts", label: "mcp server version", pattern: /name:\s*"agent-review",\s*version:\s*"([^"]+)"/, kind: "version" },
];

export interface Mismatch {
  file: string;
  label: string;
  found: string | null;
  expected: string;
}

const RELEASE_TYPES: readonly semver.ReleaseType[] = [
  "major", "premajor", "minor", "preminor", "patch", "prepatch", "prerelease",
];

/** Read the version captured by `pattern` from `text`, or null if absent. Pure. */
export function extract(text: string, pattern: RegExp): string | null {
  const m = text.match(pattern);
  return m ? m[1] : null;
}

/** Replace the version (capture group 1) of the first match of `pattern`. Pure. */
export function setInText(text: string, pattern: RegExp, version: string): { text: string; found: boolean } {
  let found = false;
  const updated = text.replace(pattern, (match: string, g1: string) => {
    found = true;
    const at = match.lastIndexOf(g1);
    return match.slice(0, at) + version + match.slice(at + g1.length);
  });
  return { text: updated, found };
}

/** Compute the next version from `current` given an explicit semver or a release-type keyword. Pure. */
export function computeVersion(current: string, spec: string): string {
  const explicit = semver.valid(spec);
  if (explicit) {
    if (!semver.gt(explicit, current)) {
      throw new Error(`version ${explicit} is not greater than the current ${current}`);
    }
    return explicit;
  }
  if ((RELEASE_TYPES as readonly string[]).includes(spec)) {
    const next = semver.inc(current, spec as semver.ReleaseType);
    if (!next) throw new Error(`cannot apply ${spec} bump to ${current}`);
    return next;
  }
  throw new Error(`invalid version "${spec}": pass an explicit semver or one of ${RELEASE_TYPES.join(", ")}`);
}

/** Apply `version` to every spot across the provided file contents. Pure. */
export function applyVersion(
  files: Map<string, string>,
  version: string,
): { files: Map<string, string>; missing: Spot[] } {
  const out = new Map(files);
  const missing: Spot[] = [];
  for (const spot of SPOTS) {
    const text = out.get(spot.file);
    if (text === undefined) {
      missing.push(spot);
      continue;
    }
    const { text: updated, found } = setInText(text, spot.pattern, version);
    if (!found) {
      missing.push(spot);
      continue;
    }
    out.set(spot.file, updated);
  }
  return { files: out, missing };
}

/** Report every spot whose version differs from `expected`. Pure. */
export function checkVersions(files: Map<string, string>, expected: string): Mismatch[] {
  const mismatches: Mismatch[] = [];
  for (const spot of SPOTS) {
    const text = files.get(spot.file);
    const found = text === undefined ? null : extract(text, spot.pattern);
    if (found !== expected) mismatches.push({ file: spot.file, label: spot.label, found, expected });
  }
  return mismatches;
}

function readSpotFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const spot of SPOTS) {
    if (!files.has(spot.file)) files.set(spot.file, readFileSync(path.join(ROOT, spot.file), "utf8"));
  }
  return files;
}

function main(argv: string[]): void {
  const args = argv.slice(2);
  const files = readSpotFiles();
  const current = extract(files.get("package.json")!, SPOTS[0].pattern);
  if (!current) throw new Error("could not read the current version from package.json");

  if (args[0] === "--check") {
    const mismatches = checkVersions(files, current);
    if (mismatches.length > 0) {
      console.error(`Version drift: every spot must be ${current} (from package.json).`);
      for (const m of mismatches) console.error(`  ${m.file}: ${m.label} = ${m.found ?? "(not found)"}`);
      process.exit(1);
    }
    console.log(`Version is consistent at ${current} across ${SPOTS.length} spots.`);
    return;
  }

  const spec = args[0];
  if (!spec) throw new Error("usage: version <patch|minor|major|X.Y.Z> | --check");
  const next = computeVersion(current, spec);
  const { files: updated, missing } = applyVersion(files, next);
  if (missing.length > 0) {
    throw new Error(`could not find the version in: ${missing.map((s) => `${s.file} (${s.label})`).join(", ")}`);
  }
  for (const [file, text] of updated) writeFileSync(path.join(ROOT, file), text);
  console.log(`Set version ${current} -> ${next} across ${SPOTS.length} spots.`);
  console.log("Run 'npm install --package-lock-only' to sync the lockfile.");
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main(process.argv);
