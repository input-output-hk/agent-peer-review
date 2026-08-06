import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "./db/open.js";
import { runSync, buildProgram, defaultDbPath, ensureDbParent } from "./cli.js";
import { FakeSyncGateway } from "./testing/fake-gateway.js";

describe("runSync", () => {
  it("syncs the requested repos and returns counts", async () => {
    const gw = new FakeSyncGateway();
    gw.seedPull("o/r", { pull: { number: 1, title: "t", author: "alice", headSha: "h", baseSha: "b", url: "u", state: "open", labels: ["ai-review"], createdAt: "c", updatedAt: "u", mergedAt: null } });
    const db = openDb(":memory:");
    const counts = await runSync({ gateway: gw, db }, { repos: ["o/r"], login: "agent-bot" });
    expect(counts.pulls).toBe(1);
    expect(db.prepare("SELECT COUNT(*) n FROM pull_request").get()).toEqual({ n: 1 });
  });
});

describe("defaultDbPath", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves dashboard.db under a temp AGENT_PEER_REVIEW_HOME, not the real home", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-home-"));
    vi.stubEnv("AGENT_PEER_REVIEW_HOME", dir);
    expect(defaultDbPath()).toBe(path.join(dir, "dashboard.db"));
  });

  it("is wired as the sync command's --db default", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-home-"));
    vi.stubEnv("AGENT_PEER_REVIEW_HOME", dir);
    const sync = buildProgram().commands.find((c) => c.name() === "sync");
    const dbOption = sync?.options.find((o) => o.long === "--db");
    expect(dbOption?.defaultValue).toBe(path.join(dir, "dashboard.db"));
  });
});

// Exercises only the directory-creation helper, never the sync command's action (which would
// construct a real OctokitGateway and hit the network). Every path below lives under a freshly
// created temp directory, never the real home.
describe("ensureDbParent", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates the parent of a default-style (agentHome-based) db path", () => {
    const base = mkdtempSync(path.join(tmpdir(), "agent-home-"));
    const home = path.join(base, "not-yet-created");
    vi.stubEnv("AGENT_PEER_REVIEW_HOME", home);
    try {
      expect(existsSync(home)).toBe(false);
      ensureDbParent(defaultDbPath());
      expect(existsSync(home)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("creates the parent of an explicit, deeply nested --db path", () => {
    const base = mkdtempSync(path.join(tmpdir(), "explicit-db-"));
    const parent = path.join(base, "a", "b", "c");
    const dbPath = path.join(parent, "dashboard.db");
    try {
      expect(existsSync(parent)).toBe(false);
      ensureDbParent(dbPath);
      expect(existsSync(parent)).toBe(true);
      expect(existsSync(dbPath)).toBe(false); // only the directory is created, not the file itself
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
