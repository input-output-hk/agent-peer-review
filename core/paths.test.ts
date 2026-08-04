import { describe, it, expect } from "vitest";
import { findPackageRoot, skillsRoot } from "./paths.js";
import path from "node:path";

const cfg = (skillsDir: string | null) => ({ githubLogin: null, skillsDir, runChecks: false, captureMetadata: false });

describe("paths", () => {
  it("finds the package root (dir containing package.json)", () => {
    expect(findPackageRoot()).toBe(process.cwd());
  });
  it("honors skillsDir override", () => {
    expect(skillsRoot(cfg("/tmp/s"))).toBe("/tmp/s");
  });
  it("defaults skills to <root>/skills", () => {
    expect(skillsRoot(cfg(null))).toBe(path.join(process.cwd(), "skills"));
  });
});
