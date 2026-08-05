import { describe, it, expect, afterEach, vi } from "vitest";
import { findPackageRoot, skillsRoot, agentHome, ensureAgentHome } from "./paths.js";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const cfg = (skillsDir: string | null) => ({ githubLogin: null, skillsDir, runChecks: false, captureMetadata: false });

describe("paths", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("finds the package root (dir containing package.json)", () => {
    expect(findPackageRoot()).toBe(process.cwd());
  });
  it("honors skillsDir override", () => {
    expect(skillsRoot(cfg("/tmp/s"))).toBe("/tmp/s");
  });
  it("defaults skills to <root>/skills", () => {
    expect(skillsRoot(cfg(null))).toBe(path.join(process.cwd(), "skills"));
  });

  describe("agentHome", () => {
    it("honors AGENT_PEER_REVIEW_HOME when set", () => {
      vi.stubEnv("AGENT_PEER_REVIEW_HOME", "/tmp/custom-agent-home");
      expect(agentHome()).toBe("/tmp/custom-agent-home");
    });
    it("otherwise defaults to ~/.agent-peer-review", () => {
      vi.stubEnv("AGENT_PEER_REVIEW_HOME", "");
      expect(agentHome()).toBe(path.join(homedir(), ".agent-peer-review"));
    });
  });

  describe("ensureAgentHome", () => {
    it("creates the directory (recursively) and returns its path, without touching the real home", () => {
      const base = mkdtempSync(path.join(tmpdir(), "agent-home-"));
      const nested = path.join(base, "nested", ".agent-peer-review");
      vi.stubEnv("AGENT_PEER_REVIEW_HOME", nested);
      try {
        expect(ensureAgentHome()).toBe(nested);
        expect(existsSync(nested)).toBe(true);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  });
});
