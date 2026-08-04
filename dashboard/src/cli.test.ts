import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "./db/open.js";
import { runSync, buildProgram, defaultDbPath } from "./cli.js";
import { FakeSyncGateway } from "./testing/fake-gateway.js";

describe("runSync", () => {
  it("syncs the requested repos and returns counts", async () => {
    const gw = new FakeSyncGateway();
    gw.seedPull("o/r", { pull: { number: 1, title: "t", author: "alice", headSha: "h", baseSha: "b", url: "u", state: "open", labels: ["agent"], createdAt: "c", updatedAt: "u", mergedAt: null } });
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
