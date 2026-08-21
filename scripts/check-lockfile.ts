import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Supply-chain guard: every tarball this repository installs must be pinned by a
 * content hash, so a compromised registry mirror or proxy cannot substitute
 * modified code. An entry with `resolved` but no `integrity` is fetched on the
 * registry's word alone.
 *
 * This matters most in the release job, which runs `npm ci` and then the whole
 * test suite and four builds. See issue #69.
 */

/**
 * One `packages` entry of an npm lockfile. Only the three fields this guard reads
 * are named; a real entry carries many more (version, license, dependencies...),
 * hence the index signature.
 */
export interface LockEntry {
  resolved?: string;
  integrity?: string;
  /** True for a workspace symlink, whose `resolved` is a local directory, not a tarball. */
  link?: boolean;
  [key: string]: unknown;
}

export interface Lockfile {
  packages?: Record<string, LockEntry>;
}

/** Every lockfile in the repository, relative to the repo root. */
export const LOCKFILES = ["package-lock.json", "docs/package-lock.json"] as const;

/**
 * Paths knowingly exempt from the hash requirement, as `<lockfile>::<package path>`.
 *
 * `@earendil-works/pi-coding-agent` (a dev dependency of the `pi` workspace) ships
 * its own `npm-shrinkwrap.json`, which carries no hashes, and npm copies that
 * subtree into our lockfile verbatim. The six entries below are the result. We
 * cannot fix them from here:
 *
 *   - Pasting the registry's own sha512 values in makes the lockfile *look*
 *     pinned without pinning anything. npm resolves a `hasShrinkwrap` subtree
 *     from the shipped shrinkwrap, not from these entries, so a deliberately
 *     wrong hash on one of them still installs cleanly (verified against
 *     npm 11.9.0). That would silence this guard while changing nothing.
 *   - The parent tarball *is* hash-pinned, so the shrinkwrap's contents are
 *     authenticated; only the six leaf tarballs it names are not.
 *
 * The exemption is by exact path, so a seventh hole fails the check, and a stale
 * entry here (one that no longer needs the exemption) fails it too, so the list
 * cannot quietly outlive the upstream cause. See issue #69.
 */
export const ALLOWED_WITHOUT_INTEGRITY: readonly string[] = [
  "package-lock.json::node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core",
  "package-lock.json::node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai",
  "package-lock.json::node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-client",
  "package-lock.json::node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-protocol",
  "package-lock.json::node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-telemetry",
  "package-lock.json::node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui",
];

/** Stable key for one lockfile entry, used by the allowlist and by both reports. */
export function entryKey(lockfile: string, pkgPath: string): string {
  return `${lockfile}::${pkgPath}`;
}

/**
 * True when `entry` fetches a tarball without pinning its content.
 *
 * A workspace link has `resolved` pointing at a local directory and nothing to
 * hash, so it is not a hole. Pure.
 */
export function needsIntegrity(entry: LockEntry): boolean {
  return Boolean(entry.resolved) && !entry.integrity && entry.link !== true;
}

/** Every entry of one parsed lockfile that fetches a tarball with no hash. Pure. */
export function unhashedEntries(lockfile: string, lock: Lockfile): string[] {
  return Object.entries(lock.packages ?? {})
    .filter(([, entry]) => needsIntegrity(entry))
    .map(([pkgPath]) => entryKey(lockfile, pkgPath));
}

export interface Audit {
  /** Unhashed entries that are not on the allowlist. Any of these fails the check. */
  violations: string[];
  /** Allowlisted entries that no longer need the exemption, so the list is out of date. */
  stale: string[];
}

/**
 * Compare the unhashed entries found across every lockfile against the allowlist.
 *
 * `keys` is the union of `unhashedEntries` over all lockfiles that were read.
 * `scanned` is the set of lockfiles that were read, so an allowlist entry naming
 * a lockfile that was not scanned is never reported as stale. Pure.
 */
export function audit(
  keys: readonly string[],
  scanned: readonly string[],
  allowed: readonly string[] = ALLOWED_WITHOUT_INTEGRITY,
): Audit {
  const found = new Set(keys);
  const allow = new Set(allowed);
  return {
    violations: keys.filter((k) => !allow.has(k)).sort(),
    stale: allowed
      .filter((k) => !found.has(k) && scanned.includes(k.split("::")[0]))
      .sort(),
  };
}

function main(): void {
  const keys: string[] = [];
  let entries = 0;
  for (const lockfile of LOCKFILES) {
    const lock = JSON.parse(readFileSync(path.join(ROOT, lockfile), "utf8")) as Lockfile;
    entries += Object.keys(lock.packages ?? {}).length;
    keys.push(...unhashedEntries(lockfile, lock));
  }

  const { violations, stale } = audit(keys, LOCKFILES);

  for (const key of violations) {
    console.error(`::error::lockfile entry has 'resolved' but no 'integrity': ${key}`);
  }
  for (const key of stale) {
    console.error(`::error::allowlisted entry no longer needs the exemption, remove it from scripts/check-lockfile.ts: ${key}`);
  }
  if (violations.length > 0 || stale.length > 0) {
    console.error(
      "Every installed tarball must be pinned by hash. If npm cannot produce one, " +
        "explain why in ALLOWED_WITHOUT_INTEGRITY rather than dropping the requirement.",
    );
    process.exit(1);
  }

  const exempt = ALLOWED_WITHOUT_INTEGRITY.length;
  console.log(
    `Checked ${entries} entries across ${LOCKFILES.length} lockfiles: every resolved tarball is hash-pinned ` +
      `(${exempt} documented exemption${exempt === 1 ? "" : "s"}).`,
  );
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
