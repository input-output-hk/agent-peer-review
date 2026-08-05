import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { openDb } from "./db/open.js";
import { buildServer } from "./server.js";
import { buildProgram, openServeDb } from "./cli.js";

describe("serve wiring", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
  });

  it("listens on 127.0.0.1 and serves /api/overview", async () => {
    app = buildServer({ db: openDb(":memory:") });
    await app.listen({ host: "127.0.0.1", port: 0 }); // ephemeral
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/api/overview`, { headers: { host: `127.0.0.1:${port}` } });
    expect(res.status).toBe(200);
  });
});

describe("serve command registration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("registers --db/--port/--host with the documented defaults", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-home-"));
    vi.stubEnv("AGENT_PEER_REVIEW_HOME", dir);
    const serve = buildProgram().commands.find((c) => c.name() === "serve");
    expect(serve).toBeDefined();
    expect(serve?.options.find((o) => o.long === "--db")?.defaultValue).toBe(path.join(dir, "dashboard.db"));
    expect(serve?.options.find((o) => o.long === "--port")?.defaultValue).toBe("4319");
    expect(serve?.options.find((o) => o.long === "--host")?.defaultValue).toBe("127.0.0.1");
  });
});

// openDbReadonly's fileMustExist option throws a raw SqliteError when the file is missing; serve
// converts that into actionable guidance instead of letting the stack trace escape to the user.
describe("openServeDb", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens an existing database read-only", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "serve-db-"));
    const dbPath = path.join(dir, "dashboard.db");
    try {
      openDb(dbPath).close();
      const db = openServeDb(dbPath);
      expect(db.prepare("SELECT 1 AS one").get()).toEqual({ one: 1 });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints a friendly message and exits 1 when the database file does not exist", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "serve-missing-db-"));
    const missing = path.join(dir, "does-not-exist.db");
    const exitError = new Error("process.exit(1)");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw exitError;
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(() => openServeDb(missing)).toThrow(exitError);
      expect(stderrSpy).toHaveBeenCalledWith(`No database at ${missing}. Run 'agent-review-dashboard sync' first.\n`);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
