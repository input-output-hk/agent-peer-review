import { describe, it, expect } from "vitest";
import { serializeMeta, serializeMarker, PRIMARY_MARKER, type PullRequest, type Review } from "@input-output-hk/agent-review";
import { openDb } from "./db/open.js";
import { sync } from "./sync.js";
import { FakeSyncGateway } from "./testing/fake-gateway.js";

const pull = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 7, title: "Add X", author: "alice", headSha: "head123", baseSha: "base123",
  url: "https://gh/pr/7", state: "merged", labels: ["agent"],
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", mergedAt: "2026-01-03T00:00:00Z", ...over,
});

const primary = (): Review => {
  const footer = serializeMeta({ v: 1, role: "primary", verdict: "approve", model: "claude-opus-4-8", agent: "claude-code", machine: "mac", claimedAt: "2026-01-02T00:00:00Z", drifted: false });
  return { id: 100, author: "agent-bot", state: "COMMENTED", body: `LGTM.\n\n${footer}\n\n${PRIMARY_MARKER}`, commitId: "head123", submittedAt: "2026-01-02T01:00:00Z" };
};

describe("sync", () => {
  it("ingests a full PR into every table with correct derived fields", async () => {
    const gw = new FakeSyncGateway();
    gw.seedPull("o/r", {
      pull: pull(),
      reviews: [primary()],
      notes: [{ id: 200, path: "a.ts", line: 5, body: "nit", author: "agent-bot" }],
      comments: [{ id: 300, author: "agent-bot", body: serializeMarker({ v: 2, reviewer: "agent-bot", machine: "mac", sha: "head123", claimedAt: "2026-01-02T00:00:00Z", model: "claude-opus-4-8", agent: "claude-code", toolVersion: "1" }) }] as any,
    });
    const db = openDb(":memory:");

    const res = await sync(gw, db, ["o/r"]);
    expect(res.counts).toEqual({ repos: 1, pulls: 1, reviews: 1, notes: 1, claims: 1 });

    const pr: any = db.prepare("SELECT id, state, merged_at FROM pull_request WHERE number=7").get();
    expect(pr.state).toBe("merged");
    const rev: any = db.prepare("SELECT role, verdict, model, is_primary, summary FROM review WHERE pr_id=?").get(pr.id);
    expect(rev).toMatchObject({ role: "primary", verdict: "approve", model: "claude-opus-4-8", is_primary: 1, summary: "LGTM." });
    expect(db.prepare("SELECT COUNT(*) n FROM claim WHERE pr_id=?").get(pr.id)).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) n FROM participant WHERE pr_id=?").get(pr.id)).toEqual({ n: 2 }); // alice(author) + agent-bot(reviewer)
    expect(db.prepare("SELECT COUNT(*) n FROM sync_run WHERE ok=1").get()).toEqual({ n: 1 });
  });

  it("is idempotent and drops upstream-deleted children on re-sync", async () => {
    const gw = new FakeSyncGateway();
    gw.seedPull("o/r", { pull: pull(), reviews: [primary()], notes: [{ id: 200, path: "a.ts", line: 5, body: "nit", author: "agent-bot" }] });
    const db = openDb(":memory:");

    await sync(gw, db, ["o/r"]);
    gw.setChildren("o/r", 7, { reviews: [primary()], notes: [] }); // the note disappeared upstream
    const res = await sync(gw, db, ["o/r"]);

    expect(db.prepare("SELECT COUNT(*) n FROM pull_request").get()).toEqual({ n: 1 }); // no dup PR
    expect(db.prepare("SELECT COUNT(*) n FROM review").get()).toEqual({ n: 1 });       // no dup review
    expect(db.prepare("SELECT COUNT(*) n FROM review_note").get()).toEqual({ n: 0 });  // stale note gone
    expect(res.counts.notes).toBe(0);
  });

  it("uses the authenticated login when none is passed", async () => {
    const gw = new FakeSyncGateway();
    gw.login = "someone-else";
    gw.seedPull("o/r", { pull: pull({ labels: ["agent"] }) });
    const db = openDb(":memory:");
    const res = await sync(gw, db, ["o/r"]); // must not throw; resolves login internally
    expect(res.counts.pulls).toBe(1);
  });
});
