import { describe, it, expect } from "vitest";
import { openDb } from "./db/open.js";
import { runSync } from "./cli.js";
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
