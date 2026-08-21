import { z } from "zod";

// Strict, not stripping: an unknown key is a typo or a field an older version wrote, and either way
// the value the user meant to set is not in effect. zod's default strip mode discarded it silently,
// which hurts most on knownAgentLogins, the one field whose failure mode is a safety gate quietly
// treating a peer agent as a human. schemas/config.schema.json has always published
// additionalProperties: false, so this makes the runtime agree with the schema. loadConfig turns the
// resulting error into a message naming the key (see core/config.ts).
export const ConfigSchema = z.object({
  githubLogin: z.string().nullable().default(null),
  defaultRepo: z.string().optional(),
  skillsDir: z.string().nullable().default(null),
  model: z.string().optional(),
  agent: z.string().optional(),
  toolVersion: z.string().optional(),
  // Opt-in switch (default off): gates ALL durable metadata capture (the review-meta footer on
  // complete/enrich, and the claim marker's machine/model/agent/toolVersion fields). When false,
  // the workflow writes a privacy-preserving v1 marker and no footer.
  captureMetadata: z.boolean().default(false),
  // Global default reviewers to request when a create call (CLI --reviewers, MCP/pi `reviewers`)
  // does not name any. Each adapter falls back to this list; ReviewRequestSchema.reviewers below
  // still requires at least one reviewer once the fallback is applied.
  reviewers: z.array(z.string().min(1)).default([]),
  // Logins the expedition human-review rail treats as agents; any login NOT listed counts as a
  // human (conservative; see core/expedition/human-review.ts). Fed to `expedite`,
  // `approveDependencyUpgrade`, and `pr_watch` by the adapters. Never fed autonomy: asking for a
  // merge is a per-invocation argument (the shipped pr-requester/pr-reviewer/pr-steward taskflows
  // pass their own `autonomy` flow argument down to the tool), never a value read from this config.
  knownAgentLogins: z.array(z.string().min(1)).default([]),
  // Per-repository default merge method ("owner/name" -> method), read by the pi adapter
  // (pi/src/extension.ts) when an expedition auto-merge call (pr_expedite,
  // pr_approve_dep_upgrade) omits an explicit mergeMethod. A repository restricted to squash-only
  // or rebase-only merge policies 405s on the operations' own "merge" default, so this lets an
  // operator pin the permitted method per repository instead of relying solely on the adapter's
  // own read of the repository's allowed merge methods (which wins only when this is unset).
  // Optional rather than defaulted to {}: unlike reviewers/knownAgentLogins, nothing besides the
  // pi adapter's own optional chaining (`config.mergeMethodByRepo?.[repo]`) ever reads this, so
  // leaving it undefined when unset avoids widening every other Config literal across the
  // codebase with a field it does not use.
  mergeMethodByRepo: z.record(z.string(), z.enum(["merge", "squash", "rebase"])).optional(),
}).strict();
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
  // Older markers always carried this. New markers omit it unless captureMetadata is enabled, so
  // the default cannot publish the reviewing machine's hostname.
  machine: z.string().min(1).optional(),
  sha: z.string().min(7),
  claimedAt: z.string().min(1),
  // v2 only: written when Config.captureMetadata is true (see core/operations/claim.ts). Absent
  // on v1 markers and omitted from the wire footer when unset.
  model: z.string().optional(),
  agent: z.string().optional(),
  toolVersion: z.string().optional(),
});
export type ClaimMarker = z.infer<typeof ClaimMarkerSchema>;

export const ReviewModeSchema = z.enum(["initial", "rereview", "convergence"]);
export type ReviewMode = z.infer<typeof ReviewModeSchema>;

export const FindingSeveritySchema = z.enum(["critical", "high", "medium", "low"]);
export const FindingConfidenceSchema = z.enum(["confirmed", "high", "plausible", "unverified"]);
export const FindingScopeSchema = z.enum(["introduced", "regression", "pre-existing", "follow-up", "accepted-risk"]);
export const FindingStatusSchema = z.enum([
  "open", "resolved", "still-open", "regressed", "superseded", "accepted-risk", "follow-up",
]);

const NON_BLOCKING_SCOPES = new Set(["pre-existing", "follow-up", "accepted-risk"]);
const NON_BLOCKING_STATUSES = new Set(["resolved", "superseded", "accepted-risk", "follow-up"]);

export const ReviewFindingSchema = z.object({
  id: z.string().min(1).max(160),
  title: z.string().min(1).max(200),
  severity: FindingSeveritySchema,
  confidence: FindingConfidenceSchema,
  scope: FindingScopeSchema,
  status: FindingStatusSchema,
  blocking: z.boolean(),
  path: z.string().min(1),
  line: z.number().int().positive(),
  evidence: z.string().min(1).max(1_000),
  remediation: z.string().min(1).max(1_000),
  relatedFindingId: z.string().min(1).max(160).nullable().optional(),
  followUpIssue: z.string().url().optional(),
  // Required by completeReview only when a previously accepted risk is reopened. Keeping the field
  // optional preserves the published result shape for every ordinary finding.
  reopenedBecause: z.string().min(1).max(1_000).optional(),
}).superRefine((finding, ctx) => {
  if (finding.followUpIssue && finding.status !== "follow-up") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["followUpIssue"], message: "a follow-up issue requires follow-up status" });
  }
  if (!finding.blocking) return;
  if (finding.confidence !== "confirmed") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["confidence"], message: "a blocking finding must be confirmed" });
  }
  if (finding.severity === "low") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["severity"], message: "a low-severity finding cannot block" });
  }
  if (NON_BLOCKING_SCOPES.has(finding.scope)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scope"], message: `${finding.scope} findings are non-blocking` });
  }
  if (NON_BLOCKING_STATUSES.has(finding.status)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: `${finding.status} findings are non-blocking` });
  }
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

function duplicateFindingIds(findings: ReviewFinding[] | undefined): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const finding of findings ?? []) {
    if (seen.has(finding.id)) duplicates.add(finding.id);
    seen.add(finding.id);
  }
  return [...duplicates];
}

function validateSingleFollowUp(findings: ReviewFinding[] | undefined, ctx: z.RefinementCtx): void {
  const urls = [...new Set((findings ?? []).flatMap((finding) => finding.followUpIssue ? [finding.followUpIssue] : []))];
  if (urls.length > 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["findings"], message: "a pull request may reference only one review follow-up issue" });
  }
}

export const ReviewResultSchema = z.object({
  repo: z.string().regex(/^[^/]+\/[^/]+$/),
  pr: z.number().int().positive(),
  event: z.enum(["approve", "request-changes", "comment"]),
  summary: z.string().min(1),
  comments: z
    .array(z.object({ path: z.string(), line: z.number().int().positive(), body: z.string() }))
    .optional(),
  // Optional for approve/comment compatibility. request-changes is fail-closed below and requires
  // the exact pin plus at least one admissible structured blocker.
  reviewedSha: z.string().min(7).optional(),
  mode: ReviewModeSchema.optional(),
  findings: z.array(ReviewFindingSchema).max(20).optional(),
}).superRefine((result, ctx) => {
  validateSingleFollowUp(result.findings, ctx);
  for (const id of duplicateFindingIds(result.findings)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["findings"], message: `duplicate finding id: ${id}` });
  }
  if (result.event !== "request-changes") return;
  if (!result.reviewedSha) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reviewedSha"], message: "request-changes requires the exact reviewed SHA" });
  }
  if (!(result.findings ?? []).some((finding) => finding.blocking && finding.confidence === "confirmed")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["findings"],
      message: "request-changes requires at least one confirmed blocking finding",
    });
  }
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export const LabelSpecSchema = z.object({
  name: z.string().min(1),
  color: z.string().regex(/^[0-9a-fA-F]{6}$/),
  description: z.string(),
});
export type LabelSpec = z.infer<typeof LabelSpecSchema>;

export const FindingAssessmentSchema = z.object({
  findingId: z.string().min(1).max(160),
  disposition: z.enum(["confirm", "refute"]),
  rationale: z.string().min(1).max(2_000),
});
export type FindingAssessment = z.infer<typeof FindingAssessmentSchema>;

export const EnrichmentSchema = z.object({
  overallVerdict: z.enum(["agree", "disagree", "mixed"]),
  summary: z.string().min(1),
  newFindings: z.array(z.object({ path: z.string(), line: z.number().int().positive(), body: z.string() })).optional(),
  reviewedSha: z.string().min(7).optional(),
  mode: ReviewModeSchema.optional(),
  findings: z.array(ReviewFindingSchema).max(20).optional(),
  assessments: z.array(FindingAssessmentSchema).max(50).optional(),
}).superRefine((result, ctx) => {
  validateSingleFollowUp(result.findings, ctx);
  for (const id of duplicateFindingIds(result.findings)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["findings"], message: `duplicate finding id: ${id}` });
  }
  const assessmentIds = result.assessments?.map((assessment) => assessment.findingId) ?? [];
  for (const id of assessmentIds.filter((id, index) => assessmentIds.indexOf(id) !== index)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["assessments"], message: `duplicate assessment: ${id}` });
  }
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
  reviewContractVersion: 1;
  reviewHistory: ReviewHistory;
}

export interface ReviewHistoryFinding {
  id: string;
  title: string;
  severity: ReviewFinding["severity"];
  scope: ReviewFinding["scope"];
  status: ReviewFinding["status"];
  blocking: boolean;
  relatedFindingId: string | null;
  followUpIssue: string | null;
}

export interface ReviewHistory {
  mode: ReviewMode;
  changesRequestedCycles: number;
  reviewedShas: string[];
  findings: ReviewHistoryFinding[];
  acceptedRisks: ReviewHistoryFinding[];
  lastVerdict: string | null;
  truncated: boolean;
}
