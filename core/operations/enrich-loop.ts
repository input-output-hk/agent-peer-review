import type { GitHubGateway } from "../github.js";
import type { Config, Enrichment } from "../model.js";
import { enrichReview } from "./enrich.js";
import { completeReview } from "./complete.js";

export interface EnrichLoopDeps {
  gh: GitHubGateway;
  config: Config;
  ttlMs: number;           // enrichReview staleness TTL
  now: () => number;       // injectable clock (Date.now in production)
  sleep: (ms: number) => Promise<void>; // injectable delay (setTimeout in production)
}

// Poll enrichReview until it resolves. On "promote" the caller becomes the anchor and posts the
// primary via completeReview. If our claim marker was superseded between promote and complete
// (a later promoter deleted it in the stale-cascade), completeReview throws "No active claim";
// treat that as a benign hand-off ("superseded"), not a crash.
export async function runEnrichLoop(
  deps: EnrichLoopDeps,
  input: { repo: string; pr: number } & Enrichment,
  opts: { pollMs: number; deadlineMs: number },
): Promise<{ outcome: "enriched" | "promoted" | "superseded" | "timeout"; result?: { url: string; drifted: boolean; superseded: boolean } | { status: "enriched"; url?: string } }> {
  const { gh, config, ttlMs, now, sleep } = deps;
  for (;;) {
    const res = await enrichReview({ gh, config, ttlMs, nowMs: now() }, input);
    if (res.status === "enriched") return { outcome: "enriched", result: { status: res.status, url: res.url } };
    if (res.status === "promote") {
      const event = input.overallVerdict === "agree" ? "approve" : input.overallVerdict === "disagree" ? "request-changes" : "comment";
      try {
        const c = await completeReview({ gh, config }, { repo: input.repo, pr: input.pr, event, summary: input.summary, comments: input.newFindings });
        return { outcome: "promoted", result: c };
      } catch (e) {
        if (/claim/i.test((e as Error).message)) return { outcome: "superseded" };
        throw e;
      }
    }
    if (now() >= opts.deadlineMs) return { outcome: "timeout" };
    await sleep(opts.pollMs);
  }
}
