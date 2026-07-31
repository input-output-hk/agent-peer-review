import { z } from "zod";

export const ConfigSchema = z.object({
  githubLogin: z.string().nullable().default(null),
  defaultRepo: z.string().optional(),
  skillsDir: z.string().nullable().default(null),
  runChecks: z.boolean().default(false),
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
  v: z.literal(1),
  reviewer: z.string().min(1),
  machine: z.string().min(1),
  sha: z.string().min(7),
  claimedAt: z.string().min(1),
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
  repoContext: Array<{ path: string; content: string }>;
  claim: { machine: string; claimedAt: string };
}
