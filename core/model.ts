import { z } from "zod";

export const ConfigSchema = z.object({
  githubLogin: z.string().nullable().default(null),
  defaultRepo: z.string().optional(),
  skillsDir: z.string().nullable().default(null),
  runChecks: z.boolean().default(false),
  model: z.string().optional(),
  agent: z.string().optional(),
  toolVersion: z.string().optional(),
  // Opt-in switch (default off): gates ALL durable metadata capture (the review-meta footer on
  // complete/enrich, and the claim marker's model/agent/toolVersion fields). When false, the
  // workflow behaves exactly as before: v1 claim markers, no footer.
  captureMetadata: z.boolean().default(false),
  // Global default reviewers to request when a create call (CLI --reviewers, MCP/pi `reviewers`)
  // does not name any. Each adapter falls back to this list; ReviewRequestSchema.reviewers below
  // still requires at least one reviewer once the fallback is applied.
  reviewers: z.array(z.string().min(1)).default([]),
});
export type Config = z.infer<typeof ConfigSchema>;

export const ReviewRequestSchema = z.object({
  repo: z.string().regex(/^[^/]+\/[^/]+$/),
  pr: z.number().int().positive(),
  skills: z.array(z.string()).default([]),
  reviewers: z.array(z.string().min(1)).min(1),
  note: z.string().optional(),
});
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;

export const ClaimMarkerSchema = z.object({
  v: z.union([z.literal(1), z.literal(2)]),
  reviewer: z.string().min(1),
  machine: z.string().min(1),
  sha: z.string().min(7),
  claimedAt: z.string().min(1),
  // v2 only: written when Config.captureMetadata is true (see core/operations/claim.ts). Absent
  // on v1 markers and omitted from the wire footer when unset.
  model: z.string().optional(),
  agent: z.string().optional(),
  toolVersion: z.string().optional(),
});
export type ClaimMarker = z.infer<typeof ClaimMarkerSchema>;

export const ReviewResultSchema = z.object({
  repo: z.string().regex(/^[^/]+\/[^/]+$/),
  pr: z.number().int().positive(),
  event: z.enum(["approve", "request-changes", "comment"]),
  summary: z.string().min(1),
  comments: z
    .array(z.object({ path: z.string(), line: z.number().int().positive(), body: z.string() }))
    .optional(),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export const LabelSpecSchema = z.object({
  name: z.string().min(1),
  color: z.string().regex(/^[0-9a-fA-F]{6}$/),
  description: z.string(),
});
export type LabelSpec = z.infer<typeof LabelSpecSchema>;

export const EnrichmentSchema = z.object({
  overallVerdict: z.enum(["agree", "disagree", "mixed"]),
  summary: z.string().min(1),
  newFindings: z.array(z.object({ path: z.string(), line: z.number().int().positive(), body: z.string() })).optional(),
});
export type Enrichment = z.infer<typeof EnrichmentSchema>;

export type Role = "anchor" | "enricher";

export interface Review { id: number; author: string; state: string; body: string; commitId: string; submittedAt: string; }
export interface ReviewComment { id: number; path: string; line: number | null; body: string; author: string; }

// Plain domain types (not validated as input).
export interface PullRequest {
  number: number;
  title: string;
  author: string;
  headSha: string;
  baseSha: string;
  url: string;
  state: "open" | "closed" | "merged";
  labels: string[];
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
}

export interface IssueComment {
  id: number;
  body: string;
  author: string;
}

export interface ReviewSummary {
  repo: string;
  pr: number;
  url: string;
  title: string;
  skills: string[];
  headSha: string;
  claim?: ClaimMarker;
}

export interface ReviewTask {
  repo: string;
  pr: number;
  url: string;
  title: string;
  author: string;
  headSha: string;
  baseSha: string;
  reviewer: string; // acting agent's GitHub login
  role: Role;
  skills: string[];
  languages: string[];
  instructions: {
    review: string;
    skills: Array<{ name: string; content: string }>;
    languages: Array<{ name: string; content: string }>;
  };
  contentPolicy: string;
  repoContext: Array<{ path: string; content: string; untrusted: true }>;
  claim: { machine: string; claimedAt: string };
}
