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

/** Seed a second repo ("o/other") with its own pull/review, to exercise the `?repo=` filter across two repos. */
async function seededTwoRepos(): Promise<DB> {
  const gw = new FakeSyncGateway();
  gw.seedPull("o/r", { pull: pull(), reviews: [primary()] });
  gw.seedPull("o/other", {
    pull: pull({ number: 9, author: "zoe" }),
    reviews: [{ id: 300, author: "other-bot", state: "COMMENTED", body: "no meta here", commitId: "head123", submittedAt: "2026-01-02T02:00:00Z" }],
  });
  const db = openDb(":memory:");
  await sync(gw, db, ["o/r", "o/other"]);
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

  it("GET /api/agents wraps listAgents in an { agents } envelope", async () => {
    app = buildServer({ db: await seededDb() });
    const res = await app.inject({ method: "GET", url: "/api/agents", headers: HOST });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agents).toEqual([
      expect.objectContaining({ agent: "claude-code", model: "claude-opus-4-8", reviews: 1, primaries: 1, enrichments: 0 }),
    ]);
  });

  it("GET /api/collaborators wraps listCollaborators in a { collaborators } envelope", async () => {
    app = buildServer({ db: await seededDb() });
    const res = await app.inject({ method: "GET", url: "/api/collaborators", headers: HOST });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.collaborators).toEqual([
      expect.objectContaining({ login: "alice", pullsAuthored: 1, reviewsReceived: 1 }),
    ]);
  });

  it("GET /api/agents on an empty database returns an empty array, not an error", async () => {
    app = buildServer({ db: openDb(":memory:") });
    const res = await app.inject({ method: "GET", url: "/api/agents", headers: HOST });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ agents: [] });
  });

  it("GET /api/collaborators on an empty database returns an empty array, not an error", async () => {
    app = buildServer({ db: openDb(":memory:") });
    const res = await app.inject({ method: "GET", url: "/api/collaborators", headers: HOST });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ collaborators: [] });
  });

  it("GET /api/agents?repo=o/r narrows to that repo", async () => {
    app = buildServer({ db: await seededTwoRepos() });
    const all = await app.inject({ method: "GET", url: "/api/agents", headers: HOST });
    expect(all.json().agents).toHaveLength(2); // claude-code/claude-opus-4-8 (o/r) + unknown (o/other)

    const scoped = await app.inject({ method: "GET", url: "/api/agents?repo=o/r", headers: HOST });
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json().agents).toEqual([
      expect.objectContaining({ agent: "claude-code", model: "claude-opus-4-8", repos: 1 }),
    ]);
  });

  it("GET /api/collaborators?repo=o/other narrows to that repo", async () => {
    app = buildServer({ db: await seededTwoRepos() });
    const res = await app.inject({ method: "GET", url: "/api/collaborators?repo=o/other", headers: HOST });
    expect(res.statusCode).toBe(200);
    expect(res.json().collaborators).toEqual([expect.objectContaining({ login: "zoe", pullsAuthored: 1 })]);
  });

  it("GET /api/agents?repo=<well-formed but nonexistent repo> returns an empty array, not an error", async () => {
    app = buildServer({ db: await seededDb() });
    const res = await app.inject({ method: "GET", url: "/api/agents?repo=o/nonexistent", headers: HOST });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ agents: [] });
  });

  it("GET /api/agents?repo=<empty string> is unfiltered (200), not 400", async () => {
    app = buildServer({ db: await seededTwoRepos() });
    const res = await app.inject({ method: "GET", url: "/api/agents?repo=", headers: HOST });
    expect(res.statusCode).toBe(200);
    expect(res.json().agents).toHaveLength(2); // same as no ?repo= at all
  });

  it("GET /api/collaborators?repo=<empty string> is unfiltered (200), not 400", async () => {
    app = buildServer({ db: await seededTwoRepos() });
    const res = await app.inject({ method: "GET", url: "/api/collaborators?repo=", headers: HOST });
    expect(res.statusCode).toBe(200);
    expect(res.json().collaborators.map((c: { login: string }) => c.login).sort()).toEqual(["alice", "zoe"]);
  });

  it("GET /api/agents?repo=a&repo=/b (duplicated key, parsed as an array by Fastify) returns 400, not 500", async () => {
    app = buildServer({ db: await seededDb() });
    const res = await app.inject({ method: "GET", url: "/api/agents?repo=a&repo=/b", headers: HOST });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTruthy();
  });

  it("GET /api/collaborators?repo=a&repo=/b (duplicated key) returns 400, not 500", async () => {
    app = buildServer({ db: await seededDb() });
    const res = await app.inject({ method: "GET", url: "/api/collaborators?repo=a&repo=/b", headers: HOST });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTruthy();
  });

  it("GET /api/agents?repo=<bad shape> returns 400 JSON", async () => {
    app = buildServer({ db: await seededDb() });
    const res = await app.inject({ method: "GET", url: "/api/agents?repo=noslash", headers: HOST });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTruthy();
  });

  it("GET /api/collaborators?repo=<bad shape> returns 400 JSON", async () => {
    app = buildServer({ db: await seededDb() });
    const res = await app.inject({ method: "GET", url: "/api/collaborators?repo=" + encodeURIComponent("/name"), headers: HOST });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTruthy();
  });
});
