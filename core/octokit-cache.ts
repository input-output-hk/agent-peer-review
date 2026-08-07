// Bounded, in-memory ETag cache for GitHub conditional requests.
//
// GitHub does not count a 304 (Not Modified) response against the REST rate
// limit, so revalidating a GET with `If-None-Match` lets repeated polls of an
// unchanged resource cost nothing. This module is the pure, Octokit-free core:
// an LRU-bounded store keyed by request identity, plus the decision logic that
// turns a raw request into a conditional one. The gateway wires it as an
// Octokit `request` hook (see core/github.ts).

/** A cached conditional-GET response: its validator plus what to replay on a 304. */
export interface CacheEntry {
  /** The `ETag` from the stored 2xx response, sent back as `If-None-Match`. */
  etag: string;
  /**
   * A deep-cloned snapshot of the response body, replayed when the server
   * answers 304 Not Modified. It must be a clone, never the live reference:
   * `octokit.paginate` mutates `response.data` in place while normalizing a
   * search-shaped body (`{ total_count, incomplete_results, items }` -> its
   * `items` array), which would otherwise corrupt this stored entry.
   */
  data: unknown;
  /**
   * The stored 2xx response headers, replayed on a 304 so callers are truly
   * unaffected. This matters for pagination: `octokit.paginate` follows the
   * `link` header, so a replayed page must carry the same `link` it had when
   * first fetched, or a multi-page result would be truncated on a cache hit.
   */
  headers: Record<string, string | undefined>;
}

/**
 * Bounded in-memory LRU cache keyed by request identity (`"<METHOD> <url>"`).
 * Reads and writes refresh recency; once the entry count exceeds `max`, the
 * least-recently-used entries are evicted oldest-first. Pure and synchronous.
 */
export class ConditionalCache {
  private readonly max: number;
  private readonly store = new Map<string, CacheEntry>();

  constructor(max = 500) {
    this.max = Math.max(1, Math.floor(max));
  }

  /** Return the entry for `key`, refreshing its recency, or undefined if absent. */
  get(key: string): CacheEntry | undefined {
    const entry = this.store.get(key);
    if (entry === undefined) return undefined;
    this.store.delete(key);
    this.store.set(key, entry); // reinsert so the most recently read is newest
    return entry;
  }

  /** Store `entry` under `key` as the newest, evicting the oldest over the cap. */
  set(key: string, entry: CacheEntry): void {
    this.store.delete(key); // ensure a reinsert lands at the newest position
    this.store.set(key, entry);
    while (this.store.size > this.max) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  /** Current number of stored entries. Exposed for tests and introspection. */
  get size(): number {
    return this.store.size;
  }
}

/** The subset of an Octokit request-hook `options` this module reads; other fields pass through. */
export interface ConditionalRequestOptions {
  method?: string;
  url?: string;
  headers?: Record<string, string | undefined>;
  [key: string]: unknown;
}

/** The subset of an Octokit response this module reads; other fields pass through. */
export interface ConditionalResponse {
  status: number;
  url?: string;
  headers?: Record<string, string | undefined>;
  data: unknown;
  [key: string]: unknown;
}

/** The inner request function an Octokit `request` hook wraps. */
export type ConditionalRequestFn = (options: ConditionalRequestOptions) => Promise<ConditionalResponse>;

/** True when `error` is the RequestError Octokit throws for a 304 Not Modified. */
export function isNotModified(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { status?: unknown }).status === 304;
}

const isSuccess = (status: number): boolean => status >= 200 && status < 300;

/**
 * Run one request as a conditional GET against `cache`, keyed by `key`.
 *
 * - Non-GET requests bypass the cache entirely and are never stored.
 * - A cached entry adds `If-None-Match`; a 2xx carrying an `ETag` is stored.
 * - Octokit throws a 304 as an error; when a matching entry exists we return a
 *   synthetic 200 carrying the cached body and headers. We serve from cache
 *   ONLY on a real 304, which by HTTP semantics means the cached body is still
 *   current, so stale data can never be served. Every other error propagates.
 *
 * When a 2xx arrives without an `ETag` we return it uncached and leave any
 * prior entry in place: that entry can only ever produce a fresh 200 (never a
 * 304) once the resource has changed, so it is self-correcting, never stale.
 */
export async function conditionalRequest(
  cache: ConditionalCache,
  key: string,
  options: ConditionalRequestOptions,
  request: ConditionalRequestFn,
): Promise<ConditionalResponse> {
  if ((options.method ?? "GET").toUpperCase() !== "GET") {
    return request(options); // writes and other verbs are never cached
  }

  const cached = cache.get(key);
  const outgoing: ConditionalRequestOptions = cached
    ? { ...options, headers: { ...options.headers, "if-none-match": cached.etag } }
    : options;

  try {
    const response = await request(outgoing);
    const etag = response.headers?.etag;
    if (isSuccess(response.status) && typeof etag === "string" && etag.length > 0) {
      // Clone on store: the returned `response` is handed to callers such as
      // octokit.paginate, which mutates `response.data` in place; the cached
      // snapshot must be insulated from that.
      cache.set(key, { etag, data: structuredClone(response.data), headers: { ...response.headers } });
    }
    return response;
  } catch (error) {
    if (cached && isNotModified(error)) {
      return {
        status: 200,
        url: options.url,
        headers: { ...cached.headers, etag: cached.etag },
        // Clone on serve too: the same callers mutate what we hand back, so
        // give them a throwaway copy and keep the stored snapshot pristine for
        // the next 304.
        data: structuredClone(cached.data),
      };
    }
    throw error; // never fabricate data for any non-304 outcome
  }
}
