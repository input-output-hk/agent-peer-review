import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { serializeMeta, PRIMARY_MARKER, type PullRequest, type Review } from "@input-output-hk/agent-review";
import { openDb, type DB } from "./db/open.js";
import { sync } from "./sync.js";
import { FakeSyncGateway } from "./testing/fake-gateway.js";
import { buildServer } from "./server.js";

const HOST = { host: "127.0.0.1:4319" };

const pull = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 7, title: "Add X", author: "alice", headSha: "head123", baseSha: "base123",
  url: "https://gh/pr/7", state: "merged", labels: ["ai-review"],
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", mergedAt: "2026-01-03T00:00:00Z", ...over,
});
const primary = (): Review => {
  const footer = serializeMeta({ v: 1, role: "primary", verdict: "approve", model: "claude-opus-4-8", agent: "claude-code" });
  return { id: 100, author: "agent-bot", state: "COMMENTED", body: `LGTM.\n\n${footer}\n\n${PRIMARY_MARKER}`, commitId: "head123", submittedAt: "2026-01-02T01:00:00Z" };
};

/** Seed a DB with one repo ("o/r") and one merged pull (#7) with a primary review, as in queries.test.ts. */
async function seededDb(): Promise<DB> {
  const gw = new FakeSyncGateway();
  gw.seedPull("o/r", { pull: pull(), reviews: [primary()] });
  const db = openDb(":memory:");
  await sync(gw, db, ["o/r"]);
  return db;
}

describe("registerApiRoutes", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
  });

  it("GET /api/overview returns aggregates", async () => {
    app = buildServer({ db: await seededDb() });
    const res = await app.inject({ method: "GET", url: "/api/overview", headers: HOST });
    expect(res.statusCode).toBe(200);
    expect(res.json().totals.pulls).toBe(1);
  });

  it("GET /api/repos lists repos with pull counts", async () => {
    app = buildServer({ db: await seededDb() });
    const res = await app.inject({ method: "GET", url: "/api/repos", headers: HOST });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ owner: "o", name: "r", pulls: 1 }]);
  });

  it("GET /api/repos/:owner/:name/pulls lists pulls", async () => {
    app = buildServer({ db: await seededDb() });
    const res = await app.inject({ method: "GET", url: "/api/repos/o/r/pulls", headers: HOST });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0].number).toBe(7);
  });

  it("GET /api/repos/:owner/:name/pulls/:number returns pull detail", async () => {
    app = buildServer({ db: await seededDb() });
    const res = await app.inject({ method: "GET", url: "/api/repos/o/r/pulls/7", headers: HOST });
    expect(res.statusCode).toBe(200);
    expect(res.json().pull.number).toBe(7);
    expect(res.json().reviews).toHaveLength(1);
  });

  it("GET a missing pull returns 404 JSON", async () => {
    app = buildServer({ db: await seededDb() });
    const res = await app.inject({ method: "GET", url: "/api/repos/o/r/pulls/999", headers: HOST });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBeTruthy();
  });

  it("GET a non-integer pull number returns 400 JSON", async () => {
    app = buildServer({ db: await seededDb() });
    const res = await app.inject({ method: "GET", url: "/api/repos/o/r/pulls/abc", headers: HOST });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTruthy();
  });

  it("GET a fractional pull number returns 400 JSON", async () => {
    app = buildServer({ db: await seededDb() });
    const res = await app.inject({ method: "GET", url: "/api/repos/o/r/pulls/1.5", headers: HOST });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTruthy();
  });

  it("GET /api/sync-runs lists sync runs", async () => {
    app = buildServer({ db: await seededDb() });
    const res = await app.inject({ method: "GET", url: "/api/sync-runs", headers: HOST });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0].ok).toBe(true);
  });
});
