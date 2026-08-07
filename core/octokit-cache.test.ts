import { describe, it, expect } from "vitest";
import {
  ConditionalCache,
  conditionalRequest,
  isNotModified,
  type ConditionalRequestOptions,
  type ConditionalResponse,
} from "./octokit-cache.js";

const entry = (etag: string, data: unknown) => ({ etag, data, headers: { etag } });

describe("ConditionalCache", () => {
  it("stores then gets an entry by key", () => {
    const cache = new ConditionalCache();
    cache.set("GET /a", entry('"v1"', { n: 1 }));
    expect(cache.get("GET /a")).toEqual({ etag: '"v1"', data: { n: 1 }, headers: { etag: '"v1"' } });
  });

  it("returns the stored etag for a key", () => {
    const cache = new ConditionalCache();
    cache.set("GET /a", entry('"abc"', "x"));
    expect(cache.get("GET /a")?.etag).toBe('"abc"');
  });

  it("keeps distinct keys isolated", () => {
    const cache = new ConditionalCache();
    cache.set("GET /a", entry('"a"', 1));
    cache.set("GET /b", entry('"b"', 2));
    expect(cache.get("GET /a")?.data).toBe(1);
    expect(cache.get("GET /b")?.data).toBe(2);
  });

  it("returns undefined for a key that is not present", () => {
    expect(new ConditionalCache().get("GET /missing")).toBeUndefined();
  });

  it("evicts the oldest entry when it grows past the cap", () => {
    const cache = new ConditionalCache(2);
    cache.set("GET /a", entry('"a"', 1));
    cache.set("GET /b", entry('"b"', 2));
    cache.set("GET /c", entry('"c"', 3)); // over the cap of 2: the oldest ("/a") is evicted
    expect(cache.size).toBe(2);
    expect(cache.get("GET /a")).toBeUndefined();
    expect(cache.get("GET /b")?.data).toBe(2);
    expect(cache.get("GET /c")?.data).toBe(3);
  });

  it("a read refreshes recency so the least-recently-used entry is evicted", () => {
    const cache = new ConditionalCache(2);
    cache.set("GET /a", entry('"a"', 1));
    cache.set("GET /b", entry('"b"', 2));
    cache.get("GET /a"); // "/a" is now most-recently used, so "/b" is the LRU victim
    cache.set("GET /c", entry('"c"', 3));
    expect(cache.get("GET /b")).toBeUndefined();
    expect(cache.get("GET /a")?.data).toBe(1);
    expect(cache.get("GET /c")?.data).toBe(3);
  });

  it("overwriting an existing key updates it without growing the cache", () => {
    const cache = new ConditionalCache(2);
    cache.set("GET /a", entry('"v1"', 1));
    cache.set("GET /a", entry('"v2"', 2));
    expect(cache.size).toBe(1);
    expect(cache.get("GET /a")).toEqual({ etag: '"v2"', data: 2, headers: { etag: '"v2"' } });
  });
});

describe("isNotModified", () => {
  it("is true only for an error carrying status 304", () => {
    expect(isNotModified({ status: 304 })).toBe(true);
    expect(isNotModified({ status: 404 })).toBe(false);
    expect(isNotModified(new Error("boom"))).toBe(false);
    expect(isNotModified(null)).toBe(false);
    expect(isNotModified(undefined)).toBe(false);
  });
});

// A scripted inner request: each call shifts the next queued outcome (a
// response to resolve or an error to throw) and records the options it saw.
// This stands in for Octokit's real transport with no network involved.
function scriptedRequest(outcomes: Array<ConditionalResponse | { throw: unknown }>) {
  const seen: ConditionalRequestOptions[] = [];
  const fn = async (options: ConditionalRequestOptions): Promise<ConditionalResponse> => {
    seen.push(options);
    const next = outcomes.shift();
    if (next && typeof next === "object" && "throw" in next) throw next.throw;
    if (!next) throw new Error("scriptedRequest: no outcome queued");
    return next;
  };
  return { fn, seen };
}

const ok = (data: unknown, headers: Record<string, string> = {}): ConditionalResponse => ({
  status: 200,
  url: "https://api.github.com/x",
  headers,
  data,
});

describe("conditionalRequest", () => {
  const KEY = "GET https://api.github.com/x";
  const getOpts: ConditionalRequestOptions = { method: "GET", url: "https://api.github.com/x", headers: {} };

  it("stores and returns data on a first GET that carries an etag", async () => {
    const cache = new ConditionalCache();
    const { fn, seen } = scriptedRequest([ok({ hello: "world" }, { etag: '"v1"' })]);
    const res = await conditionalRequest(cache, KEY, getOpts, fn);
    expect(res.data).toEqual({ hello: "world" });
    expect(seen[0].headers?.["if-none-match"]).toBeUndefined(); // nothing cached yet
    expect(cache.get(KEY)?.etag).toBe('"v1"');
  });

  it("serves an identical second GET from cache on a 304 without throwing", async () => {
    const cache = new ConditionalCache();
    const { fn, seen } = scriptedRequest([
      ok({ hello: "world" }, { etag: '"v1"', link: "<n>; rel=\"next\"" }),
      { throw: { status: 304 } }, // Octokit surfaces a 304 as a thrown RequestError
    ]);
    const first = await conditionalRequest(cache, KEY, getOpts, fn);
    const second = await conditionalRequest(cache, KEY, getOpts, fn);
    expect(second.status).toBe(200); // synthetic success, callers unaffected
    expect(second.data).toEqual(first.data);
    expect(seen[1].headers?.["if-none-match"]).toBe('"v1"'); // revalidated with the stored etag
    expect(second.headers?.link).toBe("<n>; rel=\"next\""); // link replayed so pagination still works
  });

  it("passes a non-GET through untouched and does not cache it", async () => {
    const cache = new ConditionalCache();
    const postOpts: ConditionalRequestOptions = { method: "POST", url: "https://api.github.com/x", headers: { a: "b" } };
    const { fn, seen } = scriptedRequest([ok({ created: true }, { etag: '"v1"' })]);
    const res = await conditionalRequest(cache, "POST https://api.github.com/x", postOpts, fn);
    expect(res.data).toEqual({ created: true });
    expect(seen[0]).toBe(postOpts); // exact same options object, no If-None-Match injected
    expect(seen[0].headers?.["if-none-match"]).toBeUndefined();
    expect(cache.size).toBe(0); // writes are never cached
  });

  it("returns a 200 that lacks an etag but does not cache it", async () => {
    const cache = new ConditionalCache();
    const { fn } = scriptedRequest([ok({ hello: "world" }, {})]);
    const res = await conditionalRequest(cache, KEY, getOpts, fn);
    expect(res.data).toEqual({ hello: "world" });
    expect(cache.get(KEY)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("propagates a 304 when there is no cached entry (never fabricates data)", async () => {
    const cache = new ConditionalCache();
    const { fn } = scriptedRequest([{ throw: { status: 304 } }]);
    await expect(conditionalRequest(cache, KEY, getOpts, fn)).rejects.toMatchObject({ status: 304 });
  });

  it("propagates any non-304 error unchanged", async () => {
    const cache = new ConditionalCache();
    const boom = Object.assign(new Error("server error"), { status: 500 });
    const { fn } = scriptedRequest([{ throw: boom }]);
    await expect(conditionalRequest(cache, KEY, getOpts, fn)).rejects.toBe(boom);
  });

  it("refreshes the cache when a revalidation returns fresh data with a new etag", async () => {
    const cache = new ConditionalCache();
    const { fn } = scriptedRequest([
      ok({ v: 1 }, { etag: '"v1"' }),
      ok({ v: 2 }, { etag: '"v2"' }), // resource changed: server answers 200, not 304
    ]);
    await conditionalRequest(cache, KEY, getOpts, fn);
    const second = await conditionalRequest(cache, KEY, getOpts, fn);
    expect(second.data).toEqual({ v: 2 });
    expect(cache.get(KEY)?.etag).toBe('"v2"'); // stale entry replaced, never served stale
  });
});
