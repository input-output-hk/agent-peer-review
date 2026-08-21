import { z } from "zod";
import type { IssueComment } from "./model.js";

export const FollowUpLinkSchema = z.object({
  v: z.literal(1),
  author: z.string().min(1),
  sourcePr: z.number().int().positive(),
  issue: z.number().int().positive(),
  url: z.string().url(),
});
export type FollowUpLink = z.infer<typeof FollowUpLinkSchema>;

export const followUpIssueMarker = (sourcePr: number): string =>
  `<!-- agent-review:follow-up-issue source-pr=${sourcePr} -->`;
export const FOLLOW_UP_LINK_MARKER = "<!-- agent-review:follow-up-link ";
const FOLLOW_UP_LINK_RE = /<!--\s*agent-review:follow-up-link\s+([A-Za-z0-9_-]+)\s*-->/gs;

export function serializeFollowUpLink(link: FollowUpLink): string {
  const parsed = FollowUpLinkSchema.parse(link);
  return `${FOLLOW_UP_LINK_MARKER}${Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url")} -->`;
}

export function parseFollowUpLink(body: string): FollowUpLink | null {
  const matches = [...body.matchAll(FOLLOW_UP_LINK_RE)];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    try {
      return FollowUpLinkSchema.parse(JSON.parse(Buffer.from(matches[index][1], "base64url").toString("utf8")));
    } catch {}
  }
  return null;
}

export function findFollowUpLink(comments: IssueComment[], author: string, sourcePr: number): FollowUpLink | null {
  for (const comment of comments) {
    if (comment.author.toLowerCase() !== author.toLowerCase()) continue;
    const link = parseFollowUpLink(comment.body);
    if (link?.author.toLowerCase() === author.toLowerCase() && link.sourcePr === sourcePr) return link;
  }
  return null;
}
