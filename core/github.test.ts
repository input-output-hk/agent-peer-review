import { describe, it, expect } from "vitest";
import { OctokitGateway } from "./github.js";

describe("OctokitGateway construction", () => {
  it("constructs with a token without throwing (throttling + retry plugins registered)", () => {
    const gw = new OctokitGateway("fake-token");
    expect(gw).toBeInstanceOf(OctokitGateway);
  });
});

// A GitHub REST payload for pulls.get, trimmed to the fields getPullRequest reads.
const prPayload = (number: number) => ({
  number,
  title: `Add widget ${number}`,
  user: { login: "octocat" },
  head: { sha: "headsha" },
  base: { sha: "basesha" },
  html_url: `https://github.com/o/r/pull/${number}`,
  merged: false,
  state: "open",
  labels: [{ name: "ai-review" }],
  created_at: "2026-02-01T00:00:00Z",
  updated_at: "2026-02-02T00:00:00Z",
  merged_at: null,
});

const prEtag = (number: number) => `"pr${number}-v1"`;

// A fake `fetch` injected into the gateway that serves any PR by number: the
// first call for a PR answers 200 with a per-PR ETag; a later call carrying the
// matching `If-None-Match` answers 304, the way GitHub does for an unchanged
// resource. Distinct PR URLs get distinct entries. No network is touched.
function fakeGitHubFetch() {
  const calls: Array<{ number: number; ifNoneMatch: string | undefined }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const number = Number(new URL(url).pathname.match(/\/pulls\/(\d+)$/)?.[1]);
    const etag = prEtag(number);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const ifNoneMatch = headers["if-none-match"];
    calls.push({ number, ifNoneMatch });
    if (ifNoneMatch === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    return new Response(JSON.stringify(prPayload(number)), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", etag },
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("OctokitGateway conditional-request cache (304 over Octokit)", () => {
  it("revalidates a repeated GET with If-None-Match and serves the 304 from cache", async () => {
    const { fetch, calls } = fakeGitHubFetch();
    const gw = new OctokitGateway("fake-token", fetch);

    const first = await gw.getPullRequest("o/r", 7);
    expect(first.number).toBe(7);
    expect(first.title).toBe("Add widget 7");
    expect(first.author).toBe("octocat");
    expect(calls).toHaveLength(1);
    expect(calls[0].ifNoneMatch).toBeUndefined(); // nothing cached on the first hit

    const second = await gw.getPullRequest("o/r", 7);
    expect(second).toEqual(first); // identical result, served from cache on the 304
    expect(calls).toHaveLength(2);
    expect(calls[1].ifNoneMatch).toBe('"pr7-v1"'); // the second hit revalidated with the stored etag
  });

  it("keys the cache by resolved URL so a distinct PR gets its own fresh entry", async () => {
    const { fetch, calls } = fakeGitHubFetch();
    const gw = new OctokitGateway("fake-token", fetch);
    const pr7 = await gw.getPullRequest("o/r", 7);
    await gw.getPullRequest("o/r", 7); // 304 for PR 7
    const pr8 = await gw.getPullRequest("o/r", 8); // different URL: must be fetched fresh
    await gw.getPullRequest("o/r", 8); // 304 for PR 8, from its own entry
    expect(pr7.number).toBe(7);
    expect(pr8.number).toBe(8); // served PR 8, not PR 7's cached body
    const seenFor = (n: number) => calls.filter((c) => c.number === n).map((c) => c.ifNoneMatch);
    expect(seenFor(7)).toEqual([undefined, '"pr7-v1"']); // miss then hit
    expect(seenFor(8)).toEqual([undefined, '"pr8-v1"']); // fetched fresh, then its own hit (not PR 7's)
  });
});

// A fake `fetch` for a two-page `issues.listComments` result. Each page has its
// own ETag; a repeat request carrying the matching `If-None-Match` gets a 304,
// so a second poll exercises pagination entirely from cache. This guards the
// design decision to store and replay the `link` header, without which
// octokit.paginate would truncate a cached multi-page result to its first page.
function fakePaginatedComments() {
  const base = "https://api.github.com/repos/o/r/issues/7/comments";
  const page2 = `${base}?per_page=100&page=2`;
  const pages: Record<string, { etag: string; body: unknown[]; link?: string }> = {
    "1": { etag: '"cmt-p1"', body: [{ id: 1 }, { id: 2 }], link: `<${page2}>; rel="next"` },
    "2": { etag: '"cmt-p2"', body: [{ id: 3 }] },
  };
  const calls: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const page = new URL(url).searchParams.get("page") ?? "1";
    const { etag, body, link } = pages[page];
    calls.push(`page${page}${headers["if-none-match"] === etag ? " (304)" : ""}`);
    const respHeaders: Record<string, string> = { etag };
    if (link) respHeaders.link = link;
    if (headers["if-none-match"] === etag) return new Response(null, { status: 304, headers: respHeaders });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", ...respHeaders },
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("OctokitGateway pagination survives conditional-request caching", () => {
  it("returns the full multi-page comment list on a second poll served from cache", async () => {
    const { fetch, calls } = fakePaginatedComments();
    const gw = new OctokitGateway("fake-token", fetch);

    const first = await gw.listComments("o/r", 7);
    expect(first.map((c) => c.id)).toEqual([1, 2, 3]); // both pages concatenated
    expect(calls).toEqual(["page1", "page2"]);

    const second = await gw.listComments("o/r", 7);
    expect(second).toEqual(first); // identical, though every page came back 304
    expect(calls).toEqual(["page1", "page2", "page1 (304)", "page2 (304)"]);
  });
});

// A fake `fetch` serving a SEARCH-shaped body `{ total_count, incomplete_results,
// items }` for /search/issues, plus a pulls.get payload per item. octokit.paginate
// normalizes a search body by mutating `response.data` in place (deleting
// total_count and reassigning to `items`). If the cache held that body by
// reference, the entry would be corrupted after the first poll and the 304 on
// the second poll would map over a wrapper object -> `i.number` undefined ->
// getPullRequest(undefined). This regression test fails without the deep-clone.
function fakeSearchTransport() {
  const searchEtag = '"search-v1"';
  const searchBody = { total_count: 2, incomplete_results: false, items: [{ number: 11 }, { number: 12 }] };
  const calls: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const { pathname } = new URL(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const inm = headers["if-none-match"];
    let etag: string;
    let body: unknown;
    if (pathname === "/search/issues") {
      etag = searchEtag;
      body = searchBody;
    } else {
      const number = Number(pathname.match(/\/pulls\/(\d+)$/)?.[1]);
      if (!Number.isInteger(number)) throw new Error(`unexpected request url: ${url}`);
      etag = prEtag(number);
      body = prPayload(number);
    }
    calls.push(`${pathname}${inm === etag ? " (304)" : ""}`);
    if (inm === etag) return new Response(null, { status: 304, headers: { etag } });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", etag },
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("OctokitGateway search results survive conditional-request caching", () => {
  // Generous timeout: the throttling plugin spaces /search/ calls by 2s, so the
  // second poll's search request waits before firing.
  it("serves a cached search result on a second poll without corrupting the entry", async () => {
    const { fetch, calls } = fakeSearchTransport();
    const gw = new OctokitGateway("fake-token", fetch);

    const first = await gw.listReviewRequests("o/r", "octocat");
    expect(first.map((p) => p.number)).toEqual([11, 12]);

    const second = await gw.listReviewRequests("o/r", "octocat");
    expect(second.map((p) => p.number)).toEqual([11, 12]); // identical, entry not corrupted, no throw
    expect(calls.filter((c) => c.startsWith("/search/issues")).length).toBe(2);
    expect(calls).toContain("/search/issues (304)"); // the second poll revalidated from cache
  }, 15000);
});
