import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "./db/open.js";
import { buildServer } from "./server.js";

describe("rate limit", () => {
  let app: ReturnType<typeof buildServer> | undefined;
  afterEach(async () => {
    await app?.close();
  });

  it("returns 429 once the configured request budget is exhausted", async () => {
    app = buildServer({ db: openDb(":memory:"), rateLimit: { max: 2, timeWindow: "1 minute" } });
    const headers = { host: "127.0.0.1:4319" };

    const first = await app.inject({ method: "GET", url: "/api/overview", headers });
    const second = await app.inject({ method: "GET", url: "/api/overview", headers });
    const third = await app.inject({ method: "GET", url: "/api/overview", headers });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
  });
});
