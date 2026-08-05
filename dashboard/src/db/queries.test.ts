import { describe, it, expect } from "vitest";
import { serializeMeta, PRIMARY_MARKER, type PullRequest, type Review } from "@input-output-hk/agent-review";
import { openDb } from "./open.js";
import { sync } from "../sync.js";
import { FakeSyncGateway } from "../testing/fake-gateway.js";
import { getOverview, listRepos, listPulls, getPullDetail, listSyncRuns } from "./queries.js";

const pull = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 7, title: "Add X", author: "alice", headSha: "head123", baseSha: "base123",
  url: "https://gh/pr/7", state: "merged", labels: ["agent"],
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", mergedAt: "2026-01-03T00:00:00Z", ...over,
});
const primary = (): Review => {
  const footer = serializeMeta({ v: 1, role: "primary", verdict: "approve", model: "claude-opus-4-8", agent: "claude-code" });
  return { id: 100, author: "agent-bot", state: "COMMENTED", body: `LGTM.\n\n${footer}\n\n${PRIMARY_MARKER}`, commitId: "head123", submittedAt: "2026-01-02T01:00:00Z" };
};

async function seeded() {
  const gw = new FakeSyncGateway();
  gw.seedPull("o/r", { pull: pull(), reviews: [primary()], notes: [{ id: 200, path: "a.ts", line: 5, body: "nit", author: "agent-bot" }] });
  const db = openDb(":memory:");
  await sync(gw, db, ["o/r"]);
  return db;
}

/** A review whose meta footer carries the given model (or omits `model` entirely when null). */
const reviewWithModel = (id: number, model: string | null): Review => {
  const footer = serializeMeta({ v: 1, role: "second-opinion", verdict: "agree", model: model ?? undefined });
  return { id, author: `bot${id}`, state: "COMMENTED", body: `Note.\n\n${footer}`, commitId: "head123", submittedAt: "2026-01-02T00:00:00Z" };
};

async function seededWithReviews(reviews: Review[]) {
  const gw = new FakeSyncGateway();
  gw.seedPull("o/r", { pull: pull(), reviews });
  const db = openDb(":memory:");
  await sync(gw, db, ["o/r"]);
  return db;
}

describe("queries", () => {
  it("getOverview totals, verdict split, model usage, last sync", async () => {
    const o = getOverview(await seeded());
    expect(o.totals).toEqual({ repos: 1, pulls: 1, reviews: 1 });
    expect(o.verdicts).toContainEqual({ verdict: "approve", count: 1 });
    expect(o.models).toContainEqual({ model: "claude-opus-4-8", count: 1 });
    expect(o.lastSync?.ok).toBe(true);
  });
  it("listRepos with pull counts", async () => {
    expect(listRepos(await seeded())).toEqual([{ owner: "o", name: "r", pulls: 1 }]);
  });
  it("listPulls with review count and primary verdict", async () => {
    const rows = listPulls(await seeded(), "o", "r");
    expect(rows[0]).toMatchObject({ number: 7, state: "merged", reviews: 1, primaryVerdict: "approve" });
  });
  it("getPullDetail assembles reviews, notes, participants", async () => {
    const d = getPullDetail(await seeded(), "o", "r", 7)!;
    expect(d.pull.number).toBe(7);
    expect(d.reviews[0]).toMatchObject({ role: "primary", verdict: "approve", model: "claude-opus-4-8" });
    expect(d.notes).toHaveLength(1);
    expect(d.participants.map((p) => p.login).sort()).toEqual(["agent-bot", "alice"]);
  });
  it("getPullDetail returns null for a missing pull", async () => {
    expect(getPullDetail(await seeded(), "o", "r", 999)).toBeNull();
  });
  it("listSyncRuns parses counts json", async () => {
    const runs = listSyncRuns(await seeded());
    expect(runs[0].counts.pulls).toBe(1);
    expect(runs[0].ok).toBe(true);
  });
  it("getOverview models merges NULL-model reviews into a single unknown row", async () => {
    const db = await seededWithReviews([
      reviewWithModel(301, null),
      reviewWithModel(302, null),
      reviewWithModel(303, "claude-opus-4-8"),
    ]);
    expect(getOverview(db).models).toEqual([
      { model: "unknown", count: 2 },
      { model: "claude-opus-4-8", count: 1 },
    ]);
  });
  it("getOverview models merges a literal 'unknown' model with a NULL model into one row", async () => {
    // The exact bug: GROUP BY on the raw `model` column puts NULL and the literal string
    // "unknown" in different SQL groups, even though both display as "unknown" after COALESCE.
    const db = await seededWithReviews([reviewWithModel(304, null), reviewWithModel(305, "unknown")]);
    expect(getOverview(db).models).toEqual([{ model: "unknown", count: 2 }]);
  });
  it("listRepos includes a repo with zero pulls", async () => {
    const gw = new FakeSyncGateway();
    gw.seedPull("o/r", { pull: pull(), reviews: [primary()] });
    const db = openDb(":memory:");
    await sync(gw, db, ["o/r", "o/empty"]);
    expect(listRepos(db)).toContainEqual({ owner: "o", name: "empty", pulls: 0 });
  });
  it("getPullDetail does not leak the internal db id", async () => {
    const d = getPullDetail(await seeded(), "o", "r", 7)!;
    expect("id" in d.pull).toBe(false);
  });
  it("getOverview and listSyncRuns report a failed sync_run with NULL counts", async () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO sync_run(started_at, finished_at, repos_json, counts_json, ok) VALUES(?,?,?,?,?)",
    ).run("2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z", JSON.stringify(["o/r"]), null, 0);
    const o = getOverview(db);
    expect(o.lastSync?.ok).toBe(false);
    expect(o.lastSync?.counts).toEqual({});
    const runs = listSyncRuns(db);
    expect(runs[0].ok).toBe(false);
    expect(runs[0].counts).toEqual({});
  });
});
