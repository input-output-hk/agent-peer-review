import { describe, it, expect } from "vitest";
import { OctokitGateway, UNREADABLE_CHECKS } from "./github.js";
import type { LabelSpec } from "./model.js";

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
  it("serves a cached search result on a second poll without corrupting the entry", async () => {
    const { fetch, calls } = fakeSearchTransport();
    const gw = new OctokitGateway("fake-token", fetch);

    const first = await gw.listReviewRequests("o/r", "octocat");
    expect(first.map((p) => p.number)).toEqual([11, 12]);

    const second = await gw.listReviewRequests("o/r", "octocat");
    expect(second.map((p) => p.number)).toEqual([11, 12]); // identical, entry not corrupted, no throw
    expect(calls.filter((c) => c.startsWith("/search/issues")).length).toBe(2);
    expect(calls).toContain("/search/issues (304)"); // the second poll revalidated from cache
  });
});

// ================================================================================================
// Expedition methods (PR 3): endpoint-mapping tests over the same injected-fetch seam, no network.
// ================================================================================================

// A pulls.get payload carrying the extra fields getMergeability reads (mergeable_state, mergeable,
// draft, base.ref), keyed by PR number so one fetch fake can drive several scenarios.
function fakeMergeabilityFetch(byNumber: Record<number, {
  mergeable_state: string; mergeable?: boolean | null; draft?: boolean; baseRef?: string; headSha?: string;
}>) {
  const fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const number = Number(new URL(url).pathname.match(/\/pulls\/(\d+)$/)?.[1]);
    const p = byNumber[number];
    if (!p) throw new Error(`unexpected PR number ${number}`);
    const body = {
      number, mergeable_state: p.mergeable_state, mergeable: p.mergeable ?? null, draft: p.draft ?? false,
      head: { sha: p.headSha ?? `head${number}` }, base: { sha: "basesha", ref: p.baseRef ?? "main" },
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
  }) as typeof globalThis.fetch;
  return { fetch };
}

describe("OctokitGateway.getMergeability", () => {
  it("passes through known mergeable_state values, maps has_hooks to clean, and folds an unrecognized value to unknown", async () => {
    const { fetch } = fakeMergeabilityFetch({
      1: { mergeable_state: "clean" },
      2: { mergeable_state: "dirty" },
      3: { mergeable_state: "has_hooks" }, // GHES value: mergeable, pre-receive hooks pending
      4: { mergeable_state: "some-future-value" },
    });
    const gw = new OctokitGateway("fake-token", fetch);
    expect((await gw.getMergeability("o/r", 1)).state).toBe("clean");
    expect((await gw.getMergeability("o/r", 2)).state).toBe("dirty");
    expect((await gw.getMergeability("o/r", 3)).state).toBe("clean");
    expect((await gw.getMergeability("o/r", 4)).state).toBe("unknown");
  });

  it("reports the mergeable tri-state, draft, baseRef, and headSha from the PR payload", async () => {
    const { fetch } = fakeMergeabilityFetch({
      9: { mergeable_state: "blocked", mergeable: null, draft: true, baseRef: "release/1.0", headSha: "abc123" },
    });
    const gw = new OctokitGateway("fake-token", fetch);
    expect(await gw.getMergeability("o/r", 9)).toEqual({
      state: "blocked", mergeable: null, draft: true, baseRef: "release/1.0", headSha: "abc123",
    });
  });
});

// A fake fetch serving both signals getChecks merges: checks.listForRef's check_runs (one entry per
// documented conclusion) and repos.getCombinedStatusForRef's statuses.
function fakeChecksFetch() {
  const fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const { pathname } = new URL(url);
    if (pathname.endsWith("/check-runs")) {
      const body = {
        total_count: 10,
        check_runs: [
          { name: "success-run", conclusion: "success" },
          { name: "neutral-run", conclusion: "neutral" },
          { name: "skipped-run", conclusion: "skipped" },
          { name: "queued-run", conclusion: null },
          { name: "in-progress-run", conclusion: null },
          { name: "failure-run", conclusion: "failure" },
          { name: "cancelled-run", conclusion: "cancelled" },
          { name: "timed-out-run", conclusion: "timed_out" },
          { name: "action-required-run", conclusion: "action_required" },
          { name: "stale-run", conclusion: "stale" }, // not in Octokit's static conclusion type, still real
        ],
      };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
    }
    if (pathname.endsWith("/status")) {
      const body = {
        state: "failure",
        statuses: [
          { context: "status-success", state: "success" },
          { context: "status-pending", state: "pending" },
          { context: "status-failure", state: "failure" },
          { context: "status-error", state: "error" },
        ],
      };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
    }
    throw new Error(`unexpected request url: ${url}`);
  }) as typeof globalThis.fetch;
  return { fetch };
}

describe("OctokitGateway.getChecks", () => {
  it("merges check runs and commit statuses, mapping every documented conclusion/state", async () => {
    const { fetch } = fakeChecksFetch();
    const gw = new OctokitGateway("fake-token", fetch);
    expect(await gw.getChecks("o/r", "deadbeef")).toEqual([
      { name: "success-run", status: "success" },
      { name: "neutral-run", status: "neutral" },
      { name: "skipped-run", status: "neutral" },
      { name: "queued-run", status: "pending" },
      { name: "in-progress-run", status: "pending" },
      { name: "failure-run", status: "failure" },
      { name: "cancelled-run", status: "failure" },
      { name: "timed-out-run", status: "failure" },
      { name: "action-required-run", status: "failure" },
      { name: "stale-run", status: "failure" },
      { name: "status-success", status: "success" },
      { name: "status-pending", status: "pending" },
      { name: "status-failure", status: "failure" },
      { name: "status-error", status: "failure" },
    ]);
  });

  it("maps a 403 from either checks endpoint to a fail-closed sentinel", async () => {
    const fetch = (async () => new Response(JSON.stringify({ message: "Resource not accessible" }), {
      status: 403, headers: { "content-type": "application/json; charset=utf-8" },
    })) as typeof globalThis.fetch;
    const gw = new OctokitGateway("fake-token", fetch);
    expect(await gw.getChecks("o/r", "deadbeef")).toEqual([
      { name: UNREADABLE_CHECKS, status: "failure" },
    ]);
  });

  it("still propagates non-permission failures", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ message: "server error" }), {
        status: 500, headers: { "content-type": "application/json; charset=utf-8" },
      });
    }) as typeof globalThis.fetch;
    await expect(new OctokitGateway("fake-token", fetch).getChecks("o/r", "deadbeef")).rejects.toThrow();
    expect(calls).toBe(2); // one per checks endpoint, with no production retry loop over the fake
  });
});

// A fake fetch for a two-page checks.listForRef result (check_runs, not items), each page with its
// own ETag, plus a not-cached combined-status response. Regression test for the same corruption
// risk covered by the /search/issues test above: checks.listForRef's response body is shaped like
// `{ total_count, check_runs }` with no top-level `url`, so octokit.paginate's search-shaped
// normalization (mutating response.data to the check_runs array) also applies to it. If the cache
// held that body by reference, the second poll's 304 would replay a body already mutated into an
// array on the first poll, corrupting the entry.
function fakePaginatedCheckRuns() {
  const base = "https://api.github.com/repos/o/r/commits/deadbeef/check-runs";
  const page2 = `${base}?per_page=100&page=2`;
  const pages: Record<string, { etag: string; body: unknown; link?: string }> = {
    "1": {
      etag: '"checks-p1"',
      body: { total_count: 3, check_runs: [{ name: "build", conclusion: "success" }, { name: "lint", conclusion: "success" }] },
      link: `<${page2}>; rel="next"`,
    },
    "2": { etag: '"checks-p2"', body: { total_count: 3, check_runs: [{ name: "test", conclusion: "failure" }] } },
  };
  const calls: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const { pathname } = new URL(url);
    if (pathname.endsWith("/status")) {
      // No ETag: always fresh, and irrelevant to the pagination regression this test targets.
      return new Response(JSON.stringify({ state: "success", statuses: [] }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
    }
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

describe("OctokitGateway.getChecks pagination survives conditional-request caching", () => {
  it("returns the full multi-page check-runs list on a second poll served entirely from cache, uncorrupted", async () => {
    const { fetch, calls } = fakePaginatedCheckRuns();
    const gw = new OctokitGateway("fake-token", fetch);

    const first = await gw.getChecks("o/r", "deadbeef");
    const runsOnly = first.filter((c) => ["build", "lint", "test"].includes(c.name));
    expect(runsOnly).toEqual([
      { name: "build", status: "success" },
      { name: "lint", status: "success" },
      { name: "test", status: "failure" },
    ]);
    expect(calls).toEqual(["page1", "page2"]);

    const second = await gw.getChecks("o/r", "deadbeef");
    expect(second).toEqual(first); // identical, though both check-run pages came back 304
    expect(calls).toEqual(["page1", "page2", "page1 (304)", "page2 (304)"]);
  });
});

function fakeBranchProtectionFetch(byBranch: Record<string, { status: number; body?: unknown }>) {
  const fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const branch = new URL(url).pathname.match(/\/branches\/([^/]+)\/protection$/)?.[1] ?? "";
    const entry = byBranch[branch];
    if (!entry) throw new Error(`unexpected branch ${branch}`);
    return new Response(JSON.stringify(entry.body ?? { message: "error" }), {
      status: entry.status, headers: { "content-type": "application/json; charset=utf-8" },
    });
  }) as typeof globalThis.fetch;
  return { fetch };
}

describe("OctokitGateway.getBranchProtection", () => {
  it('maps 404 to "none" and 403 to "unknown"', async () => {
    const { fetch } = fakeBranchProtectionFetch({ main: { status: 404 }, locked: { status: 403 } });
    const gw = new OctokitGateway("fake-token", fetch);
    expect(await gw.getBranchProtection("o/r", "main")).toBe("none");
    expect(await gw.getBranchProtection("o/r", "locked")).toBe("unknown");
  });

  it("maps a protection payload, including a 0 required_approving_review_count with reviews still required", async () => {
    const { fetch } = fakeBranchProtectionFetch({
      strict: {
        status: 200,
        body: {
          required_pull_request_reviews: { required_approving_review_count: 0, dismiss_stale_reviews: true },
          required_status_checks: { contexts: ["ci/build", "ci/test"] },
          enforce_admins: { enabled: true },
          required_conversation_resolution: { enabled: true },
        },
      },
    });
    const gw = new OctokitGateway("fake-token", fetch);
    expect(await gw.getBranchProtection("o/r", "strict")).toEqual({
      requiresPullRequestReviews: true,
      requiredApprovingReviewCount: 0,
      requiredChecks: ["ci/build", "ci/test"],
      enforceAdmins: true,
      requiresConversationResolution: true,
      dismissesStaleReviews: true,
    });
  });

  it("defaults every optional field when the protection payload omits them", async () => {
    const { fetch } = fakeBranchProtectionFetch({ minimal: { status: 200, body: {} } });
    const gw = new OctokitGateway("fake-token", fetch);
    expect(await gw.getBranchProtection("o/r", "minimal")).toEqual({
      requiresPullRequestReviews: false,
      requiredApprovingReviewCount: 0,
      requiredChecks: [],
      enforceAdmins: false,
      requiresConversationResolution: false,
      dismissesStaleReviews: false,
    });
  });

  // Read for issue #53: it is what says whether GitHub is already retiring approvals on push, and so
  // whether an approval of an older commit may be counted. It is nested under
  // required_pull_request_reviews, so a branch that requires no review reports nothing here, and the
  // false that produces is both the honest and the conservative reading.
  it.each([
    ["explicitly false", { required_pull_request_reviews: { dismiss_stale_reviews: false } }, false],
    ["absent from the reviews block", { required_pull_request_reviews: {} }, false],
    ["absent with no reviews block at all", {}, false],
    ["enabled", { required_pull_request_reviews: { dismiss_stale_reviews: true } }, true],
  ])("maps dismiss_stale_reviews %s to %s", async (_label, body, expected) => {
    const { fetch } = fakeBranchProtectionFetch({ b: { status: 200, body } });
    const gw = new OctokitGateway("fake-token", fetch);
    expect(await gw.getBranchProtection("o/r", "b")).toMatchObject({ dismissesStaleReviews: expected });
  });

  it("does not mistake an explicit null required_pull_request_reviews for reviews being required", async () => {
    const { fetch } = fakeBranchProtectionFetch({ nullreviews: { status: 200, body: { required_pull_request_reviews: null } } });
    const gw = new OctokitGateway("fake-token", fetch);
    expect(await gw.getBranchProtection("o/r", "nullreviews")).toMatchObject({ requiresPullRequestReviews: false });
  });

  it("derives requiredChecks from the modern checks[] field when contexts is absent", async () => {
    const { fetch } = fakeBranchProtectionFetch({
      modern: { status: 200, body: { required_status_checks: { checks: [{ context: "ci/build" }, { context: "ci/test" }] } } },
    });
    const gw = new OctokitGateway("fake-token", fetch);
    expect(await gw.getBranchProtection("o/r", "modern")).toMatchObject({ requiredChecks: ["ci/build", "ci/test"] });
  });
});

function fakeMergeFetch(byNumber: Record<number, { status: number; body: unknown }>) {
  const calls: Array<{ number: number; body: any }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const number = Number(new URL(url).pathname.match(/\/pulls\/(\d+)\/merge$/)?.[1]);
    const body = typeof init?.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : undefined;
    calls.push({ number, body });
    const entry = byNumber[number];
    if (!entry) throw new Error(`unexpected PR number ${number}`);
    return new Response(JSON.stringify(entry.body), { status: entry.status, headers: { "content-type": "application/json; charset=utf-8" } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("OctokitGateway.mergePull", () => {
  it("merges successfully, sending the given sha, method, and commit title", async () => {
    const { fetch, calls } = fakeMergeFetch({ 1: { status: 200, body: { sha: "mergesha", merged: true, message: "ok" } } });
    const gw = new OctokitGateway("fake-token", fetch);
    const result = await gw.mergePull("o/r", 1, { sha: "headsha1", method: "squash", commitTitle: "Squash it" });
    expect(result).toEqual({ merged: true, sha: "mergesha", message: "ok", reason: null });
    expect(calls[0].body).toMatchObject({ sha: "headsha1", merge_method: "squash", commit_title: "Squash it" });
  });

  it('defaults the merge method to "merge" when opts.method is omitted', async () => {
    const { fetch, calls } = fakeMergeFetch({ 2: { status: 200, body: { sha: "s", merged: true, message: "ok" } } });
    const gw = new OctokitGateway("fake-token", fetch);
    await gw.mergePull("o/r", 2, { sha: "headsha2" });
    expect(calls[0].body).toMatchObject({ sha: "headsha2", merge_method: "merge" });
  });

  // 405 is now in the gateway's doNotRetry list (core/github.ts), so this resolves in one request,
  // not three; no generous timeout needed.
  it('returns a non-throwing failure on 405 (not mergeable), with reason "not-mergeable"', async () => {
    const { fetch } = fakeMergeFetch({ 3: { status: 405, body: { message: "Pull Request is not mergeable" } } });
    const gw = new OctokitGateway("fake-token", fetch);
    const result = await gw.mergePull("o/r", 3, { sha: "headsha3" });
    expect(result).toEqual({ merged: false, sha: null, message: "Pull Request is not mergeable", reason: "not-mergeable" });
  });

  // 409 is also in the gateway's doNotRetry list: retrying the identical sha after a 409 could
  // never succeed, so it must not retry.
  it('returns a non-throwing failure on 409 (head moved), with reason "head-moved"', async () => {
    const { fetch } = fakeMergeFetch({ 4: { status: 409, body: { message: "Head branch was modified" } } });
    const gw = new OctokitGateway("fake-token", fetch);
    const result = await gw.mergePull("o/r", 4, { sha: "headsha4" });
    expect(result).toEqual({ merged: false, sha: null, message: "Head branch was modified", reason: "head-moved" });
  });
});

function fakeUpdateBranchFetch(byNumber: Record<number, { status: number; body: unknown }>) {
  const calls: Array<{ number: number; body: any }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const number = Number(new URL(url).pathname.match(/\/pulls\/(\d+)\/update-branch$/)?.[1]);
    const body = typeof init?.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : undefined;
    calls.push({ number, body });
    const entry = byNumber[number];
    if (!entry) throw new Error(`unexpected PR number ${number}`);
    return new Response(JSON.stringify(entry.body), { status: entry.status, headers: { "content-type": "application/json; charset=utf-8" } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("OctokitGateway.updateBranch", () => {
  it('returns "updated" on success and passes expected_head_sha when given', async () => {
    const { fetch, calls } = fakeUpdateBranchFetch({ 1: { status: 202, body: { message: "Updating pull request branch." } } });
    const gw = new OctokitGateway("fake-token", fetch);
    expect(await gw.updateBranch("o/r", 1, "expectedsha")).toBe("updated");
    expect(calls[0].body).toEqual({ expected_head_sha: "expectedsha" });
  });

  it("omits expected_head_sha from the request when not given", async () => {
    const { fetch, calls } = fakeUpdateBranchFetch({ 2: { status: 202, body: { message: "ok" } } });
    const gw = new OctokitGateway("fake-token", fetch);
    await gw.updateBranch("o/r", 2);
    expect(calls[0].body).toBeUndefined();
  });

  it('maps 422 to "conflict" (covers both a real merge conflict and an expected_head_sha mismatch)', async () => {
    const { fetch } = fakeUpdateBranchFetch({ 3: { status: 422, body: { message: "mismatch" } } });
    const gw = new OctokitGateway("fake-token", fetch);
    expect(await gw.updateBranch("o/r", 3, "stalesha")).toBe("conflict");
  });

  it('maps 403 to "forbidden" instead of throwing', async () => {
    const { fetch } = fakeUpdateBranchFetch({ 4: { status: 403, body: { message: "Resource not accessible" } } });
    const gw = new OctokitGateway("fake-token", fetch);
    expect(await gw.updateBranch("o/r", 4, "headsha")).toBe("forbidden");
  });
});

describe("OctokitGateway.listPullFilesDetailed", () => {
  it("maps filename, status, additions, deletions, and patch", async () => {
    const fetch = (async () => new Response(JSON.stringify([
      { filename: "a.ts", status: "modified", additions: 3, deletions: 1, patch: "@@ -1 +1 @@" },
      { filename: "b.ts", status: "added", additions: 10, deletions: 0 },
    ]), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } })) as typeof globalThis.fetch;
    const gw = new OctokitGateway("fake-token", fetch);
    expect(await gw.listPullFilesDetailed("o/r", 1)).toEqual([
      { filename: "a.ts", status: "modified", additions: 3, deletions: 1, patch: "@@ -1 +1 @@" },
      { filename: "b.ts", status: "added", additions: 10, deletions: 0, patch: undefined },
    ]);
  });
});

function fakeRemoveLabelFetch(byLabel: Record<string, number>) {
  const calls: string[] = [];
  const fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const label = new URL(url).pathname.match(/\/labels\/([^/]+)$/)?.[1] ?? "";
    calls.push(label);
    const status = byLabel[label] ?? 200;
    const body = status === 200 ? [] : { message: "Label does not exist" };
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("OctokitGateway.removeLabel", () => {
  it("resolves normally on success", async () => {
    const { fetch, calls } = fakeRemoveLabelFetch({ "ai-review": 200 });
    const gw = new OctokitGateway("fake-token", fetch);
    await expect(gw.removeLabel("o/r", 1, "ai-review")).resolves.toBeUndefined();
    expect(calls).toEqual(["ai-review"]);
  });

  it("swallows a 404 (label already absent) instead of throwing", async () => {
    const { fetch } = fakeRemoveLabelFetch({ gone: 404 });
    const gw = new OctokitGateway("fake-token", fetch);
    await expect(gw.removeLabel("o/r", 1, "gone")).resolves.toBeUndefined();
  });
});

function fakeDeleteCommentFetch(byId: Record<string, number>) {
  const calls: string[] = [];
  const fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const id = new URL(url).pathname.match(/\/comments\/([^/]+)$/)?.[1] ?? "";
    calls.push(id);
    const status = byId[id] ?? 204;
    const body = status === 204 ? null : JSON.stringify({ message: "Not Found" });
    return new Response(body, { status, headers: { "content-type": "application/json; charset=utf-8" } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("OctokitGateway.deleteComment", () => {
  it("resolves normally on success", async () => {
    const { fetch, calls } = fakeDeleteCommentFetch({ "7": 204 });
    const gw = new OctokitGateway("fake-token", fetch);
    await expect(gw.deleteComment("o/r", 7)).resolves.toBeUndefined();
    expect(calls).toEqual(["7"]);
  });

  // A maintainer deleting our stale proposal between listComments and deleteComment is ordinary,
  // not exceptional: the comment is gone either way, so the tick must not abort over it.
  it("swallows a 404 (comment already deleted) instead of throwing", async () => {
    const { fetch } = fakeDeleteCommentFetch({ "8": 404 });
    const gw = new OctokitGateway("fake-token", fetch);
    await expect(gw.deleteComment("o/r", 8)).resolves.toBeUndefined();
  });

  it("propagates other errors", async () => {
    const { fetch } = fakeDeleteCommentFetch({ "9": 403 });
    const gw = new OctokitGateway("fake-token", fetch);
    await expect(gw.deleteComment("o/r", 9)).rejects.toThrow();
  });
});

describe("OctokitGateway.listRequestedReviewers", () => {
  it("maps users and teams to login/slug arrays", async () => {
    const fetch = (async () => new Response(JSON.stringify({
      users: [{ login: "alice" }, { login: "bob" }],
      teams: [{ slug: "backend" }],
    }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } })) as typeof globalThis.fetch;
    const gw = new OctokitGateway("fake-token", fetch);
    expect(await gw.listRequestedReviewers("o/r", 1)).toEqual({ users: ["alice", "bob"], teams: ["backend"] });
  });
});

describe("OctokitGateway.addAssignees", () => {
  it("sends the given assignees", async () => {
    const calls: unknown[] = [];
    const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
      return new Response(JSON.stringify({}), { status: 201, headers: { "content-type": "application/json; charset=utf-8" } });
    }) as typeof globalThis.fetch;
    const gw = new OctokitGateway("fake-token", fetch);
    await gw.addAssignees("o/r", 1, ["alice", "bob"]);
    expect(calls[0]).toEqual({ assignees: ["alice", "bob"] });
  });
});

function fakeActorTypeFetch(byLogin: Record<string, { status: number; type?: string }>) {
  const fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const login = new URL(url).pathname.match(/\/users\/([^/]+)$/)?.[1] ?? "";
    const entry = byLogin[login];
    if (!entry) throw new Error(`unexpected login ${login}`);
    if (entry.status !== 200) {
      return new Response(JSON.stringify({ message: "Not Found" }), { status: entry.status, headers: { "content-type": "application/json; charset=utf-8" } });
    }
    return new Response(JSON.stringify({ login, type: entry.type }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
  }) as typeof globalThis.fetch;
  return { fetch };
}

describe("OctokitGateway.getActorType", () => {
  it('maps "User" and "Bot", and a 404 to "unknown"', async () => {
    const { fetch } = fakeActorTypeFetch({
      octocat: { status: 200, type: "User" },
      reviewbot: { status: 200, type: "Bot" },
      ghost: { status: 404 },
    });
    const gw = new OctokitGateway("fake-token", fetch);
    expect(await gw.getActorType("octocat")).toBe("User");
    expect(await gw.getActorType("reviewbot")).toBe("Bot");
    expect(await gw.getActorType("ghost")).toBe("unknown");
  });
});

function fakeAlertsFetch(byRepo: Record<string, { status: number; body?: unknown }>) {
  const fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const match = new URL(url).pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/dependabot\/alerts$/);
    const repo = match ? `${match[1]}/${match[2]}` : "";
    const entry = byRepo[repo];
    if (!entry) throw new Error(`unexpected repo ${repo}`);
    return new Response(JSON.stringify(entry.body ?? { message: "error" }), { status: entry.status, headers: { "content-type": "application/json; charset=utf-8" } });
  }) as typeof globalThis.fetch;
  return { fetch };
}

describe("OctokitGateway.listOpenSecurityAlertCount", () => {
  it("returns the open alert count", async () => {
    const { fetch } = fakeAlertsFetch({ "o/r": { status: 200, body: [{ number: 1 }, { number: 2 }, { number: 3 }] } });
    const gw = new OctokitGateway("fake-token", fetch);
    expect(await gw.listOpenSecurityAlertCount("o/r")).toBe(3);
  });

  it("maps 403 (and 404/451) to null instead of throwing", async () => {
    const { fetch: f403 } = fakeAlertsFetch({ "o/1": { status: 403 } });
    expect(await new OctokitGateway("fake-token", f403).listOpenSecurityAlertCount("o/1")).toBeNull();
    const { fetch: f404 } = fakeAlertsFetch({ "o/2": { status: 404 } });
    expect(await new OctokitGateway("fake-token", f404).listOpenSecurityAlertCount("o/2")).toBeNull();
    const { fetch: f451 } = fakeAlertsFetch({ "o/3": { status: 451 } });
    expect(await new OctokitGateway("fake-token", f451).listOpenSecurityAlertCount("o/3")).toBeNull();
  });

  it("propagates other errors", async () => {
    const { fetch } = fakeAlertsFetch({ "o/4": { status: 400 } });
    await expect(new OctokitGateway("fake-token", fetch).listOpenSecurityAlertCount("o/4")).rejects.toThrow();
  });
});

// A fake fetch over one repository's labels: GET lists whatever the test seeded, POST and PATCH
// answer success without recording state. `calls` is what matters here, since these tests are about
// how many round trips each path costs.
function fakeLabelFetch(existing: LabelSpec[]) {
  const calls: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(`${method} ${new URL(url).pathname}`);
    const body = method === "GET" ? existing : { ok: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const TRIGGER_LABEL: LabelSpec = { name: "ai-review", color: "0e8a16", description: "Request an AI agent review" };

describe("OctokitGateway.ensureLabel", () => {
  it("lists the repository's labels itself when the caller passes no snapshot", async () => {
    const { fetch, calls } = fakeLabelFetch([]);
    const gw = new OctokitGateway("fake-token", fetch);
    expect(await gw.ensureLabel("o/r", TRIGGER_LABEL)).toBe("created");
    expect(calls).toEqual(["GET /repos/o/r/labels", "POST /repos/o/r/labels"]);
  });

  it("decides from a snapshot the caller already has, without listing again", async () => {
    const { fetch, calls } = fakeLabelFetch([]);
    const gw = new OctokitGateway("fake-token", fetch);
    expect(await gw.ensureLabel("o/r", TRIGGER_LABEL, [])).toBe("created");
    expect(calls).toEqual(["POST /repos/o/r/labels"]); // no list: that is the point of the parameter
  });

  it("reports unchanged from a snapshot without writing or listing anything", async () => {
    const { fetch, calls } = fakeLabelFetch([]);
    const gw = new OctokitGateway("fake-token", fetch);
    expect(await gw.ensureLabel("o/r", TRIGGER_LABEL, [TRIGGER_LABEL])).toBe("unchanged");
    expect(calls).toEqual([]);
  });

  it("updates a drifted label found in the snapshot, exactly as it would from its own list", async () => {
    const drifted: LabelSpec = { ...TRIGGER_LABEL, description: "an older description" };
    const { fetch: passed, calls: passedCalls } = fakeLabelFetch([]);
    expect(await new OctokitGateway("fake-token", passed).ensureLabel("o/r", TRIGGER_LABEL, [drifted])).toBe("updated");
    expect(passedCalls).toEqual(["PATCH /repos/o/r/labels/ai-review"]);

    const { fetch: listed, calls: listedCalls } = fakeLabelFetch([drifted]);
    expect(await new OctokitGateway("fake-token", listed).ensureLabel("o/r", TRIGGER_LABEL)).toBe("updated");
    expect(listedCalls).toEqual(["GET /repos/o/r/labels", "PATCH /repos/o/r/labels/ai-review"]);
  });
});
