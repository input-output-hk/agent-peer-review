import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { composeInstructions, hasSkill, composeLanguages } from "./skills.js";

let dir: string;
const cfg = () => ({ githubLogin: null, skillsDir: dir, runChecks: false, captureMetadata: false });
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "skills-"));
  writeFileSync(path.join(dir, "review.md"), "# default review");
  writeFileSync(path.join(dir, "security.md"), "# security");
  mkdirSync(path.join(dir, "lang"), { recursive: true });
  writeFileSync(path.join(dir, "lang", "rust.md"), "# rust");
  writeFileSync(path.join(dir, "lang", "go.md"), "# go");
});

describe("skills", () => {
  it("composes review + existing specialty, ignoring missing", () => {
    const r = composeInstructions(["security", "does-not-exist"], cfg());
    expect(r.review).toContain("default review");
    expect(r.skills.map((s) => s.name)).toEqual(["security"]);
  });
  it("hasSkill is false for a missing file", () => {
    expect(hasSkill("nope", cfg())).toBe(false);
  });
  it("composes existing language skills, dropping missing ones", () => {
    const r = composeLanguages(["rust", "go", "nope"], cfg());
    expect(r.map((s) => s.name)).toEqual(["rust", "go"]);
    expect(r.map((s) => s.content)).toEqual(["# rust", "# go"]);
  });
});
