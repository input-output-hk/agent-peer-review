import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "./db/open.js";
import { buildServer, isAllowedHost, isAllowedOrigin } from "./server.js";

describe("host guard", () => {
  it("allows localhost variants, rejects others", () => {
    expect(isAllowedHost("127.0.0.1:4319")).toBe(true);
    expect(isAllowedHost("localhost:4319")).toBe(true);
    expect(isAllowedHost("[::1]:4319")).toBe(true);
    expect(isAllowedHost("evil.example.com")).toBe(false);
    expect(isAllowedHost(undefined)).toBe(false);
  });

  it("rejects a longer domain that merely starts with an allowed name", () => {
    expect(isAllowedHost("localhost.evil.com")).toBe(false);
    expect(isAllowedHost("127.0.0.1.evil.com")).toBe(false);
  });
});

describe("origin guard", () => {
  it("allows same-origin (no header) and localhost variants, rejects others and malformed values", () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:4319")).toBe(true);
    expect(isAllowedOrigin("http://localhost:4319")).toBe(true);
    expect(isAllowedOrigin("http://[::1]:4319")).toBe(true);
    expect(isAllowedOrigin("http://evil.example.com")).toBe(false);
    expect(isAllowedOrigin("not a url")).toBe(false);
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
  it("lets a good Host with no Origin header through the guard to the route", async () => {
    app = buildServer({ db: openDb(":memory:") });
    const res = await app.inject({ method: "GET", url: "/api/overview", headers: { host: "127.0.0.1:4319" } });
    expect(res.statusCode).toBe(200);
  });
  it("lets a good Host with a matching IPv6 loopback Origin through the guard to the route", async () => {
    app = buildServer({ db: openDb(":memory:") });
    const res = await app.inject({
      method: "GET",
      url: "/api/overview",
      headers: { host: "127.0.0.1:4319", origin: "http://[::1]:4319" },
    });
    expect(res.statusCode).toBe(200);
  });
});
