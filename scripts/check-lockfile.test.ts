import { describe, it, expect } from "vitest";
import {
  ALLOWED_WITHOUT_INTEGRITY, LOCKFILES, audit, entryKey, needsIntegrity, unhashedEntries,
} from "./check-lockfile.js";

const LOCK = "package-lock.json";

// Shapes taken from the real lockfile: a pinned dependency, a workspace symlink,
// the root entry, and one of the shrinkwrapped tarballs that arrives unpinned.
const pinned = {
  version: "7.8.5",
  resolved: "https://registry.npmjs.org/semver/-/semver-7.8.5.tgz",
  integrity: "sha512-Y7/KDsb8LjooZpwaqGyulO6DQlksgCncchHGk+sZIY4SBvUocMBEFH5Ur1fI4dV+Jvl0w6cjvucaIi40puRioA==",
};
const workspaceLink = { resolved: "pi", link: true };
const unpinned = {
  version: "0.84.1",
  resolved: "https://registry.npmjs.org/@earendil-works/pi-tui/-/pi-tui-0.84.1.tgz",
};

describe("needsIntegrity", () => {
  it("accepts a tarball pinned by hash", () => {
    expect(needsIntegrity(pinned)).toBe(false);
  });

  it("flags a tarball fetched with no hash", () => {
    expect(needsIntegrity(unpinned)).toBe(true);
  });

  it("ignores a workspace symlink, which has no tarball to hash", () => {
    expect(needsIntegrity(workspaceLink)).toBe(false);
  });

  it("ignores the root entry and anything else with no 'resolved'", () => {
    expect(needsIntegrity({})).toBe(false);
    expect(needsIntegrity({ integrity: "sha512-abc" })).toBe(false);
  });

  it("flags an empty integrity string, not just a missing key", () => {
    expect(needsIntegrity({ ...unpinned, integrity: "" })).toBe(true);
  });
});

describe("unhashedEntries", () => {
  it("returns keyed paths for exactly the unpinned tarballs", () => {
    const lock = {
      packages: {
        "": { name: "root" },
        "node_modules/semver": pinned,
        "node_modules/pi-tui": unpinned,
        "node_modules/@input-output-hk/agent-review-pi": workspaceLink,
      },
    };
    expect(unhashedEntries(LOCK, lock)).toEqual([entryKey(LOCK, "node_modules/pi-tui")]);
  });

  it("tolerates a lockfile with no packages map", () => {
    expect(unhashedEntries(LOCK, {})).toEqual([]);
  });
});

describe("audit", () => {
  const allowed = [entryKey(LOCK, "node_modules/a")];

  it("passes when the holes are exactly the allowlisted ones", () => {
    expect(audit([entryKey(LOCK, "node_modules/a")], [LOCK], allowed)).toEqual({ violations: [], stale: [] });
  });

  it("fails on a hole that is not allowlisted", () => {
    const { violations, stale } = audit(
      [entryKey(LOCK, "node_modules/a"), entryKey(LOCK, "node_modules/b")],
      [LOCK],
      allowed,
    );
    expect(violations).toEqual([entryKey(LOCK, "node_modules/b")]);
    expect(stale).toEqual([]);
  });

  it("fails on a stale exemption, so the allowlist cannot outlive its cause", () => {
    const { violations, stale } = audit([], [LOCK], allowed);
    expect(violations).toEqual([]);
    expect(stale).toEqual(allowed);
  });

  it("does not call an exemption stale when its lockfile was not scanned", () => {
    expect(audit([], ["docs/package-lock.json"], allowed)).toEqual({ violations: [], stale: [] });
  });

  it("reports every lockfile, not just the first", () => {
    const { violations } = audit(
      [entryKey(LOCK, "node_modules/b"), entryKey("docs/package-lock.json", "node_modules/c")],
      LOCKFILES,
      [],
    );
    expect(violations).toEqual([
      entryKey("docs/package-lock.json", "node_modules/c"),
      entryKey(LOCK, "node_modules/b"),
    ]);
  });
});

describe("the shipped allowlist", () => {
  it("covers both lockfiles", () => {
    expect(LOCKFILES).toEqual(["package-lock.json", "docs/package-lock.json"]);
  });

  // The exemption exists only because @earendil-works/pi-coding-agent ships a
  // hashless npm-shrinkwrap.json. Anything outside that subtree is a different
  // problem and must not ride in on this list.
  it("exempts only exact paths inside the pi-coding-agent shrinkwrap subtree", () => {
    expect(ALLOWED_WITHOUT_INTEGRITY).toHaveLength(6);
    for (const key of ALLOWED_WITHOUT_INTEGRITY) {
      expect(key.startsWith("package-lock.json::node_modules/@earendil-works/pi-coding-agent/node_modules/")).toBe(true);
      expect(key).not.toMatch(/[*?]/);
    }
    expect(new Set(ALLOWED_WITHOUT_INTEGRITY).size).toBe(ALLOWED_WITHOUT_INTEGRITY.length);
  });
});
