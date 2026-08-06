import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hostname } from "node:os";
import { loadConfig, OctokitGateway, createReview, listReviews, claimReview, completeReview, enrichReview, bootstrap } from "../core/index.js";

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

export function buildServer(): McpServer {
  const server = new McpServer({ name: "agent-review", version: "0.2.0" });
  const gh = () => new OctokitGateway();
  const cfg = () => loadConfig(process.env.AGENT_REVIEW_CONFIG);

  server.registerTool("review_create",
    { title: "Request a review", description: "Add the ai-review label + skill labels and request the reviewer(s) natively.",
      inputSchema: { repo: z.string(), pr: z.number(), skills: z.array(z.string()).default([]), reviewers: z.array(z.string()).min(1), note: z.string().optional() } },
    async (a) => ok(await createReview(gh(), { repo: a.repo, pr: a.pr, skills: a.skills ?? [], reviewers: a.reviewers, note: a.note })));

  server.registerTool("review_list",
    { title: "List review requests", description: "Open PRs labeled ai-review requested from a login (defaults to yours).",
      inputSchema: { repo: z.string(), reviewer: z.string().optional() } },
    async (a) => ok(await listReviews(gh(), { repo: a.repo, login: a.reviewer ?? cfg().githubLogin ?? undefined })));

  server.registerTool("review_claim",
    { title: "Claim a review", description: "Pin the head SHA, post a claim marker, return composed skills.",
      inputSchema: { repo: z.string(), pr: z.number() } },
    async (a) => ok(await claimReview({ gh: gh(), config: cfg(), machine: hostname(), now: new Date().toISOString() }, { repo: a.repo, pr: a.pr })));

  server.registerTool("review_complete",
    { title: "Complete a review", description: "Submit a PR review at the pinned SHA (clears the request) and delete the claim marker.",
      inputSchema: { repo: z.string(), pr: z.number(), event: z.enum(["approve", "request-changes", "comment"]), summary: z.string(),
        comments: z.array(z.object({ path: z.string(), line: z.number(), body: z.string() })).optional() } },
    async (a) => ok(await completeReview({ gh: gh(), config: cfg() }, a)));

  server.registerTool("review_enrich",
    { title: "Enrich a review", description: "Post a consolidated second opinion once the primary review exists; else returns waiting/promote.",
      inputSchema: { repo: z.string(), pr: z.number(), verdict: z.enum(["agree", "disagree", "mixed"]), summary: z.string(),
        newFindings: z.array(z.object({ path: z.string(), line: z.number(), body: z.string() })).optional() } },
    async (a) => ok(await enrichReview({ gh: gh(), config: cfg(), ttlMs: 30 * 60_000, nowMs: Date.now() },
      { repo: a.repo, pr: a.pr, overallVerdict: a.verdict, summary: a.summary, newFindings: a.newFindings })));

  server.registerTool("labels_bootstrap",
    { title: "Bootstrap labels", description: "Idempotently create/update the ai-review + skill labels.",
      inputSchema: { repo: z.string() } },
    async (a) => ok(await bootstrap(gh(), { repo: a.repo })));

  return server;
}
