import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { openDb } from "./db/open.js";
import { buildServer } from "./server.js";

// staticRoot points at the repo public/ dir for the test:
const staticRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const HOST = { host: "127.0.0.1:4319" };

describe("static SPA serving", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
  });

  it("serves index.html at /", async () => {
    app = buildServer({ db: openDb(":memory:"), staticRoot });
    const res = await app.inject({ method: "GET", url: "/", headers: HOST });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Agent Peer Review Dashboard");
  });

  it("SPA fallback: unknown non-api path returns index.html", async () => {
    app = buildServer({ db: openDb(":memory:"), staticRoot });
    const res = await app.inject({ method: "GET", url: "/repos/o/r", headers: HOST });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Agent Peer Review Dashboard");
  });

  it("unknown /api path returns JSON 404", async () => {
    app = buildServer({ db: openDb(":memory:"), staticRoot });
    const res = await app.inject({ method: "GET", url: "/api/nope", headers: HOST });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBeTruthy();
  });
});
