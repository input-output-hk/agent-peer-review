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
    expect(cfg.reviewers).toEqual([]); // no default reviewers unless configured
  });
  it("parses reviewers from a config file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ reviewers: ["patextreme", "yshyn-iohk"] }));
    expect(loadConfig(file).reviewers).toEqual(["patextreme", "yshyn-iohk"]);
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
  it("an empty-string env var does not clobber the config file value (regression)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ model: "claude-opus-4-8" }));
    vi.stubEnv("AGENT_REVIEW_MODEL", "");
    expect(loadConfig(file).model).toBe("claude-opus-4-8");
  });
  it("an empty-string env var does not clobber the default (undefined) value (regression)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, "{}");
    vi.stubEnv("AGENT_REVIEW_MODEL", "");
    expect(loadConfig(file).model).toBeUndefined();
  });
  it("a non-empty env var still overrides the config file value", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ model: "claude-opus-4-8" }));
    vi.stubEnv("AGENT_REVIEW_MODEL", "x");
    expect(loadConfig(file).model).toBe("x");
  });
  it("AGENT_REVIEW_REVIEWERS parses a comma-separated list, trimming whitespace", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, "{}");
    vi.stubEnv("AGENT_REVIEW_REVIEWERS", "alice, bob ,  carol");
    expect(loadConfig(file).reviewers).toEqual(["alice", "bob", "carol"]);
  });
  it("a set AGENT_REVIEW_REVIEWERS overrides a config file's reviewers list", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ reviewers: ["patextreme"] }));
    vi.stubEnv("AGENT_REVIEW_REVIEWERS", "alice");
    expect(loadConfig(file).reviewers).toEqual(["alice"]);
  });
  it("an empty-string AGENT_REVIEW_REVIEWERS does not clobber the config file value (regression)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ reviewers: ["patextreme"] }));
    vi.stubEnv("AGENT_REVIEW_REVIEWERS", "");
    expect(loadConfig(file).reviewers).toEqual(["patextreme"]);
  });
  it("an unset AGENT_REVIEW_REVIEWERS leaves the default [] in place", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, "{}");
    expect(loadConfig(file).reviewers).toEqual([]);
  });
  it("falls back to <agentHome>/config.json when no explicit path or AGENT_REVIEW_CONFIG is set", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-home-"));
    vi.stubEnv("AGENT_PEER_REVIEW_HOME", dir);
    vi.stubEnv("AGENT_REVIEW_CONFIG", "");
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ githubLogin: "from-agent-home" }));
    expect(loadConfig().githubLogin).toBe("from-agent-home");
  });
});
