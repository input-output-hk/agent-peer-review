import { z } from "zod";

export const ReviewMetaSchema = z.object({
  v: z.literal(1),
  model: z.string().optional(),
  agent: z.string().optional(),
  toolVersion: z.string().optional(),
  role: z.enum(["primary", "second-opinion"]),
  verdict: z.string().min(1),
  claimedAt: z.string().optional(),
  machine: z.string().optional(),
  drifted: z.boolean().optional(),
});
export type ReviewMeta = z.infer<typeof ReviewMetaSchema>;

// Hidden tag placed in a review body (by completeReview/enrichReview) carrying the durable
// dashboard-facing metadata for that review: model/agent/toolVersion, role, verdict, and claim
// timing. Written only when Config.captureMetadata is true (see core/config.ts).
export const META_MARKER = "<!-- agent-review:meta";

// `[^{}]*` (not a lazy `.*?`) keeps this linear on adversarial review bodies: the meta JSON is
// flat (no nested braces), so a bounded character class matches it without catastrophic
// backtracking (see the js/polynomial-redos code-scanning alert; core/claim-marker.ts uses the
// same pattern for the same reason). The `g` flag lets parseMeta enumerate every occurrence via
// matchAll (which iterates a fresh clone and never mutates this shared regex's lastIndex) so it
// can prefer the LAST one.
const META_RE = /<!--\s*agent-review:meta\s+(\{[^{}]*\})\s*-->/gs;

export function serializeMeta(m: ReviewMeta): string {
  return `${META_MARKER} ${JSON.stringify(m)} -->`;
}

// Matches the LAST footer in the body, not the first: the genuine footer is always written at or
// near the end (just before PRIMARY_MARKER for a primary review, or last for a second opinion),
// so an earlier look-alike comment (e.g. spoofed text quoted in the review summary) must lose to
// the real one.
export function parseMeta(body: string): ReviewMeta | null {
  const matches = [...body.matchAll(META_RE)];
  const last = matches.at(-1);
  if (!last) return null;
  try {
    return ReviewMetaSchema.parse(JSON.parse(last[1]));
  } catch {
    return null;
  }
}
