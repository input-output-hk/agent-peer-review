import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hostname } from "node:os";
import {
  loadConfig, OctokitGateway, createReview, listReviews, claimReview, completeReview, enrichReview, bootstrap,
  recordSelfReview, createFollowUp, DEFAULT_CLAIM_TTL_MS, inspectReviewWorkspace,
  type GitHubGateway, type Config, type ReviewWorkspaceState,
} from "../core/index.js";

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

const mode = z.enum(["initial", "rereview", "convergence"]);
const finding = z.object({
  id: z.string(), title: z.string(), severity: z.enum(["critical", "high", "medium", "low"]),
  confidence: z.enum(["confirmed", "high", "plausible", "unverified"]),
  scope: z.enum(["introduced", "regression", "pre-existing", "follow-up", "accepted-risk"]),
  status: z.enum(["open", "resolved", "still-open", "regressed", "superseded", "accepted-risk", "follow-up"]),
  blocking: z.boolean(), path: z.string(), line: z.number(), evidence: z.string(), remediation: z.string(),
  relatedFindingId: z.string().nullable().optional(), followUpIssue: z.string().url().optional(), reopenedBecause: z.string().optional(),
});

export function buildServer(deps: {
  gh?: () => GitHubGateway;
  config?: () => Config;
  workspaceState?: (repo: string, cwd?: string) => ReviewWorkspaceState;
} = {}): McpServer {
  const server = new McpServer({ name: "agent-review", version: "0.5.0" });
  const gh = deps.gh ?? (() => new OctokitGateway());
  const cfg = deps.config ?? (() => loadConfig(process.env.AGENT_REVIEW_CONFIG));
  const workspaceState = deps.workspaceState ?? inspectReviewWorkspace;

  server.registerTool("review_create",
    { title: "Request a review", description: "Add the ai-review label + skill labels and request the reviewer(s) natively (defaults to the configured \"reviewers\" when omitted).",
      inputSchema: { repo: z.string(), pr: z.number(), skills: z.array(z.string()).default([]), reviewers: z.array(z.string()).optional(), note: z.string().optional() } },
    async (a) => {
      const reviewers = a.reviewers?.length ? a.reviewers : cfg().reviewers;
      if (reviewers.length === 0) {
        throw new Error('No reviewers: pass "reviewers" or set a default "reviewers" in ~/.agent-peer-review/config.json');
      }
      return ok(await createReview(gh(), { repo: a.repo, pr: a.pr, skills: a.skills ?? [], reviewers, note: a.note }));
    });

  server.registerTool("review_list",
    { title: "List review requests", description: "Open PRs labeled ai-review requested from a login (defaults to yours).",
      inputSchema: { repo: z.string(), reviewer: z.string().optional() } },
    async (a) => ok(await listReviews(gh(), { repo: a.repo, login: a.reviewer ?? cfg().githubLogin ?? undefined })));

  server.registerTool("review_claim",
    { title: "Claim a review", description: "Pin the head SHA, post a claim marker, return composed skills.",
      inputSchema: { repo: z.string(), pr: z.number() } },
    async (a) => ok(await claimReview({ gh: gh(), config: cfg(), machine: hostname(), now: new Date().toISOString() }, { repo: a.repo, pr: a.pr })));

  server.registerTool("review_self_review",
    { title: "Record successful self-review", description: "Post the author's exact-head Self-review summary before requesting a peer.",
      inputSchema: { repo: z.string(), pr: z.number(), reviewedSha: z.string(), whatChanged: z.string(), howVerified: z.string(), whyReady: z.string(), workspace: z.string().optional() } },
    async (a) => ok(await recordSelfReview({ gh: gh(), workspace: workspaceState(a.repo, a.workspace) }, a)));

  server.registerTool("review_followup",
    { title: "Create the single review follow-up", description: "Create at most one meaningful follow-up issue for disproportionate work.",
      inputSchema: { repo: z.string(), pr: z.number(), reviewedSha: z.string(), title: z.string(), problem: z.string(), rationale: z.string(),
        acceptanceCriteria: z.array(z.string()), findingIds: z.array(z.string()), workspace: z.string().optional() } },
    async (a) => {
      const { workspace, ...input } = a;
      return ok(await createFollowUp({ gh: gh(), workspace: workspaceState(a.repo, workspace) }, input));
    });

  server.registerTool("review_complete",
    { title: "Complete a review", description: "Submit an exact-head, clean-worktree review and delete the claim marker.",
      inputSchema: { repo: z.string(), pr: z.number(), event: z.enum(["approve", "request-changes", "comment"]), summary: z.string(),
        comments: z.array(z.object({ path: z.string(), line: z.number(), body: z.string() })).optional(),
        reviewedSha: z.string().optional(), mode: mode.optional(), findings: z.array(finding).optional(), workspace: z.string().optional() } },
    async (a) => {
      const { workspace, ...result } = a;
      return ok(await completeReview({ gh: gh(), config: cfg(), workspace: workspaceState(a.repo, workspace) }, result));
    });

  server.registerTool("review_enrich",
    { title: "Enrich a review", description: "Post a consolidated second opinion once the primary review exists; else returns waiting/promote.",
      inputSchema: { repo: z.string(), pr: z.number(), verdict: z.enum(["agree", "disagree", "mixed"]), summary: z.string(),
        newFindings: z.array(z.object({ path: z.string(), line: z.number(), body: z.string() })).optional(),
        reviewedSha: z.string().optional(), mode: mode.optional(), findings: z.array(finding).optional(),
        assessments: z.array(z.object({ findingId: z.string(), disposition: z.enum(["confirm", "refute"]), rationale: z.string() })).optional(),
        workspace: z.string().optional() } },
    async (a) => ok(await enrichReview({
      gh: gh(), config: cfg(), ttlMs: DEFAULT_CLAIM_TTL_MS, nowMs: Date.now(), workspace: workspaceState(a.repo, a.workspace),
    }, {
      repo: a.repo, pr: a.pr, overallVerdict: a.verdict, summary: a.summary, newFindings: a.newFindings,
      reviewedSha: a.reviewedSha, mode: a.mode, findings: a.findings, assessments: a.assessments,
    })));

  server.registerTool("labels_bootstrap",
    { title: "Bootstrap labels", description: "Idempotently create/update the ai-review + skill labels.",
      inputSchema: { repo: z.string() } },
    async (a) => ok(await bootstrap(gh(), { repo: a.repo })));

  return server;
}
