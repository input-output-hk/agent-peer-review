import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "./config.js";

describe("config", () => {
  it("loads and validates an explicit config file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ githubLogin: "yshyn-iohk" }));
    const cfg = loadConfig(file);
    expect(cfg.githubLogin).toBe("yshyn-iohk");
    expect(cfg.skillsDir).toBeNull();
  });
  it("applies defaults for an empty config file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, "{}");
    const cfg = loadConfig(file);
    expect(cfg.githubLogin).toBeNull();
    expect(cfg.runChecks).toBe(false);
  });
});
