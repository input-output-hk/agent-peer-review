import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "./config.js";

describe("config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

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
    expect(cfg.captureMetadata).toBe(false); // opt-in metadata capture is off unless set
  });
  it("reads model/agent/toolVersion/captureMetadata from env vars", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, "{}");
    vi.stubEnv("AGENT_REVIEW_MODEL", "claude-opus-4-8");
    vi.stubEnv("AGENT_REVIEW_AGENT", "claude-code");
    vi.stubEnv("AGENT_REVIEW_TOOL_VERSION", "1.2.3");
    vi.stubEnv("AGENT_REVIEW_CAPTURE_METADATA", "true");
    const cfg = loadConfig(file);
    expect(cfg.model).toBe("claude-opus-4-8");
    expect(cfg.agent).toBe("claude-code");
    expect(cfg.toolVersion).toBe("1.2.3");
    expect(cfg.captureMetadata).toBe(true);
  });
  it("an env var overrides a config file value", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ captureMetadata: true }));
    vi.stubEnv("AGENT_REVIEW_CAPTURE_METADATA", "false");
    expect(loadConfig(file).captureMetadata).toBe(false);
  });
});
