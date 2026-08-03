import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { csv, readMaybeFile, repoOf } from "./util.js";

describe("csv", () => {
  it("returns an empty array for undefined", () => {
    expect(csv(undefined)).toEqual([]);
  });
  it("trims whitespace around entries", () => {
    expect(csv(" a , b ,c")).toEqual(["a", "b", "c"]);
  });
  it("drops blank entries", () => {
    expect(csv("a,,b, ,c")).toEqual(["a", "b", "c"]);
  });
});

describe("readMaybeFile", () => {
  it("passes a plain string through unchanged", () => {
    expect(readMaybeFile("hello")).toBe("hello");
  });
  it("reads file contents when the value is prefixed with @", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cli-util-"));
    const file = path.join(dir, "note.txt");
    writeFileSync(file, "from disk");
    expect(readMaybeFile(`@${file}`)).toBe("from disk");
  });
});

describe("repoOf", () => {
  it("prefers opts.repo over the default", () => {
    expect(repoOf({ repo: "o/r" }, "d/d")).toBe("o/r");
  });
  it("falls back to the default repo when opts.repo is absent", () => {
    expect(repoOf({}, "d/d")).toBe("d/d");
  });
  it("throws when neither opts.repo nor a default is set", () => {
    expect(() => repoOf({})).toThrow(/--repo is required/);
  });
});
