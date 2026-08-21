#!/usr/bin/env node

// Deliberately dependency-free. The privileged release job runs this in a fresh checkout that has
// never installed repository dependencies, so validation code cannot persist a hook or environment
// change and observe RELEASE_TOKEN later. Keep this file on Node built-ins only.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseVersion(value) {
  const match = VERSION.exec(value);
  if (!match) throw new Error(`invalid semantic version "${value}"`);
  const numbers = match.slice(1, 4).map(Number);
  if (numbers.some((part) => !Number.isSafeInteger(part))) {
    throw new Error(`invalid semantic version "${value}": numeric components exceed JavaScript's safe integer range`);
  }
  const prerelease = match[4]?.split(".") ?? [];
  for (const identifier of prerelease) {
    if (/^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0")) {
      throw new Error(`invalid semantic version "${value}": numeric prerelease identifiers cannot have leading zeroes`);
    }
  }
  return { raw: value, major: numbers[0], minor: numbers[1], patch: numbers[2], prerelease };
}

function compareIdentifiers(left, right) {
  const leftNumber = /^\d+$/.test(left);
  const rightNumber = /^\d+$/.test(right);
  if (leftNumber && rightNumber) {
    return left.length === right.length ? left.localeCompare(right) : left.length - right.length;
  }
  if (leftNumber !== rightNumber) return leftNumber ? -1 : 1;
  return left.localeCompare(right);
}

function compareVersions(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
    if (left.prerelease[i] === undefined) return -1;
    if (right.prerelease[i] === undefined) return 1;
    const compared = compareIdentifiers(left.prerelease[i], right.prerelease[i]);
    if (compared !== 0) return compared;
  }
  return 0;
}

export function computeVersion(currentValue, spec) {
  const current = parseVersion(currentValue);
  let next;
  // Match node-semver's release-type behavior used by scripts/version.ts. A prerelease already at
  // the requested base boundary is promoted by dropping its suffix instead of skipping the stable
  // version (0.6.0-rc.1 + patch/minor -> 0.6.0; 2.0.0-rc.1 + major -> 2.0.0).
  if (spec === "major") {
    next = current.prerelease.length > 0 && current.minor === 0 && current.patch === 0
      ? `${current.major}.0.0`
      : `${current.major + 1}.0.0`;
  } else if (spec === "minor") {
    next = current.prerelease.length > 0 && current.patch === 0
      ? `${current.major}.${current.minor}.0`
      : `${current.major}.${current.minor + 1}.0`;
  } else if (spec === "patch") {
    next = current.prerelease.length > 0
      ? `${current.major}.${current.minor}.${current.patch}`
      : `${current.major}.${current.minor}.${current.patch + 1}`;
  } else next = parseVersion(spec).raw;
  if (compareVersions(parseVersion(next), current) <= 0) {
    throw new Error(`version ${next} is not greater than the current ${current.raw}`);
  }
  return next;
}

function replaceVersion(text, pattern, expected, next, label) {
  const matches = [...text.matchAll(new RegExp(pattern.source, `${pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`}`))];
  if (matches.length !== 1 || matches[0][1] !== expected) {
    const found = matches.map((match) => match[1]).join(", ") || "nothing";
    throw new Error(`${label}: expected exactly one ${expected}, found ${found}`);
  }
  return text.replace(pattern, (whole, captured) => whole.replace(captured, next));
}

function finalizeChangelog(markdown, version) {
  const lines = markdown.split("\n");
  let fenced = false;
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (start === -1) {
      if (/^##\s+Unreleased\s*$/i.test(lines[i])) start = i;
    } else if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (start === -1) throw new Error("no '## Unreleased' section in CHANGELOG.md");
  const body = lines.slice(start + 1, end);
  const notes = body.join("\n").trim();
  if (!notes) throw new Error("'## Unreleased' is empty; add entries before releasing");
  const rewritten = [...lines.slice(0, start), "## Unreleased", "", `## ${version}`, ...body, ...lines.slice(end)].join("\n");
  return { markdown: rewritten, notes };
}

function read(root, file) {
  return readFileSync(path.join(root, file), "utf8");
}

function write(root, file, contents) {
  writeFileSync(path.join(root, file), contents);
}

export function writeRelease(root, spec, notesOut) {
  const rootPackage = read(root, "package.json");
  const currentMatch = rootPackage.match(/"version":\s*"([^"]+)"/);
  if (!currentMatch) throw new Error("could not read the current version from package.json");
  const current = currentMatch[1];
  const next = computeVersion(current, spec);

  const replacements = [
    ["package.json", /"version":\s*"([^"]+)"/, "root package version"],
    ["pi/package.json", /"version":\s*"([^"]+)"/, "pi package version"],
    ["pi/package.json", /"@input-output-hk\/agent-review":\s*"\^([^"]+)"/, "pi core dependency"],
    ["dashboard/package.json", /"version":\s*"([^"]+)"/, "dashboard package version"],
    ["dashboard/package.json", /"@input-output-hk\/agent-review":\s*"\^([^"]+)"/, "dashboard core dependency"],
    ["cli/index.ts", /\.version\("([^"]+)"\)/, "CLI version"],
    ["mcp/server.ts", /name:\s*"agent-review",\s*version:\s*"([^"]+)"/, "MCP version"],
  ];
  const changed = new Map();
  for (const [file, pattern, label] of replacements) {
    const source = changed.get(file) ?? read(root, file);
    // Range patterns capture only the version after `^`, so the same replacement preserves the
    // prefix while ordinary version patterns replace the complete captured value.
    changed.set(file, replaceVersion(source, pattern, current, next, label));
  }
  for (const [file, contents] of changed) write(root, file, contents);

  const lock = JSON.parse(read(root, "package-lock.json"));
  const lockSpots = [
    [lock, "version", current, next, "lockfile root version"],
    [lock.packages?.[""], "version", current, next, "lockfile root package"],
    [lock.packages?.dashboard, "version", current, next, "lockfile dashboard package"],
    [lock.packages?.dashboard?.dependencies, "@input-output-hk/agent-review", `^${current}`, `^${next}`, "lockfile dashboard core dependency"],
    [lock.packages?.pi, "version", current, next, "lockfile pi package"],
    [lock.packages?.pi?.dependencies, "@input-output-hk/agent-review", `^${current}`, `^${next}`, "lockfile pi core dependency"],
  ];
  for (const [object, key, expected, value, label] of lockSpots) {
    if (!object || object[key] !== expected) throw new Error(`${label}: expected ${expected}, found ${object?.[key]}`);
    object[key] = value;
  }
  write(root, "package-lock.json", `${JSON.stringify(lock, null, 2)}\n`);

  const released = finalizeChangelog(read(root, "CHANGELOG.md"), next);
  write(root, "CHANGELOG.md", released.markdown);
  writeFileSync(notesOut, `${released.notes}\n`);
  return { version: next, prerelease: parseVersion(next).prerelease.length > 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [spec, notesOut] = process.argv.slice(2);
  if (!spec || !notesOut) throw new Error("usage: write-release <patch|minor|major|X.Y.Z> <notes-out>");
  const result = writeRelease(process.cwd(), spec, notesOut);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${result.version}\nprerelease=${result.prerelease}\n`);
  }
  process.stdout.write(`Prepared release v${result.version}\n`);
}
