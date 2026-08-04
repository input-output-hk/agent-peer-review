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
// same pattern for the same reason).
const META_RE = /<!--\s*agent-review:meta\s+(\{[^{}]*\})\s*-->/s;

export function serializeMeta(m: ReviewMeta): string {
  return `${META_MARKER} ${JSON.stringify(m)} -->`;
}

export function parseMeta(body: string): ReviewMeta | null {
  const match = META_RE.exec(body);
  if (!match) return null;
  try {
    return ReviewMetaSchema.parse(JSON.parse(match[1]));
  } catch {
    return null;
  }
}
