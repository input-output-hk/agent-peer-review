import { z } from "zod";
import type { IssueComment } from "./model.js";

export const SelfReviewMarkerSchema = z.object({
  v: z.literal(1),
  author: z.string().min(1),
  sha: z.string().min(7),
  status: z.literal("passed"),
});
export type SelfReviewMarker = z.infer<typeof SelfReviewMarkerSchema>;

export const SELF_REVIEW_MARKER = "<!-- agent-review:self-review ";
const SELF_REVIEW_RE = /<!--\s*agent-review:self-review\s+([A-Za-z0-9_-]+)\s*-->/gs;

export function serializeSelfReviewMarker(marker: SelfReviewMarker): string {
  const parsed = SelfReviewMarkerSchema.parse(marker);
  return `${SELF_REVIEW_MARKER}${Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url")} -->`;
}

export function parseSelfReviewMarker(body: string): SelfReviewMarker | null {
  const matches = [...body.matchAll(SELF_REVIEW_RE)];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    try {
      return SelfReviewMarkerSchema.parse(JSON.parse(Buffer.from(matches[index][1], "base64url").toString("utf8")));
    } catch {}
  }
  return null;
}

/** Marker fields are untrusted until the GitHub comment author authenticates them. */
export function findPassedSelfReview(comments: IssueComment[], author: string, sha: string): IssueComment | undefined {
  return comments.find((comment) => {
    if (comment.author.toLowerCase() !== author.toLowerCase()) return false;
    const marker = parseSelfReviewMarker(comment.body);
    return marker?.author.toLowerCase() === author.toLowerCase() && marker.sha === sha && marker.status === "passed";
  });
}
