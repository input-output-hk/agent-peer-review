import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "./db/open.js";
import { buildServer, isAllowedHost } from "./server.js";

describe("host guard", () => {
  it("allows localhost variants, rejects others", () => {
    expect(isAllowedHost("127.0.0.1:4319")).toBe(true);
    expect(isAllowedHost("localhost:4319")).toBe(true);
    expect(isAllowedHost("[::1]:4319")).toBe(true);
    expect(isAllowedHost("evil.example.com")).toBe(false);
    expect(isAllowedHost(undefined)).toBe(false);
  });
});

describe("buildServer guard", () => {
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;
  afterEach(async () => { await app?.close(); });
  it("rejects a forbidden Host with 403", async () => {
    app = buildServer({ db: openDb(":memory:") });
    const res = await app.inject({ method: "GET", url: "/api/overview", headers: { host: "evil.example.com" } });
    expect(res.statusCode).toBe(403);
  });
  it("rejects a cross-origin request even with a good Host", async () => {
    app = buildServer({ db: openDb(":memory:") });
    const res = await app.inject({ method: "GET", url: "/api/overview", headers: { host: "127.0.0.1:4319", origin: "http://evil.example.com" } });
    expect(res.statusCode).toBe(403);
  });
});
