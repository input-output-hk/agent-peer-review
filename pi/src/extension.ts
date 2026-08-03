import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { hostname } from "node:os";
import {
  loadConfig, OctokitGateway, createReview, listReviews, claimReview, completeReview, enrichReview, bootstrap,
  type GitHubGateway, type Config,
} from "@input-output-hk/agent-review";

// Same shape as mcp/server.ts's ok(), plus `details`: the real ExtensionAPI's
// `registerTool` requires `execute` to resolve `AgentToolResult<TDetails>`, and
// `AgentToolResult.details` is a required field. `{}` is a valid (empty) details
// payload; the model-facing content is unchanged.
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], details: {} });

export function registerTools(
  pi: ExtensionAPI,
  deps: { gh?: () => GitHubGateway; config?: () => Config } = {},
): void {
  const gh = deps.gh ?? (() => new OctokitGateway());
  const cfg = deps.config ?? (() => loadConfig());

  pi.registerTool({ name: "review_create", label: "Request a review", description: "Add the agent label + skill labels and request reviewer(s).",
    parameters: Type.Object({ repo: Type.String(), pr: Type.Number(), skills: Type.Optional(Type.Array(Type.String())), reviewers: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }), note: Type.Optional(Type.String()) }),
    async execute(_id, p) { return ok(await createReview(gh(), { repo: p.repo, pr: p.pr, skills: p.skills ?? [], reviewers: p.reviewers, note: p.note })); } });

  pi.registerTool({ name: "review_list", label: "List review requests", description: "Open PRs labeled agent requested from a login (defaults to yours).",
    parameters: Type.Object({ repo: Type.String(), reviewer: Type.Optional(Type.String()) }),
    async execute(_id, p) { return ok(await listReviews(gh(), { repo: p.repo, login: p.reviewer ?? cfg().githubLogin ?? undefined })); } });

  pi.registerTool({ name: "review_claim", label: "Claim a review", description: "Pin the head SHA, post a claim marker, return composed skills + context.",
    parameters: Type.Object({ repo: Type.String(), pr: Type.Number() }),
    async execute(_id, p) { return ok(await claimReview({ gh: gh(), config: cfg(), machine: hostname(), now: new Date().toISOString() }, { repo: p.repo, pr: p.pr })); } });

  pi.registerTool({ name: "review_complete", label: "Complete a review", description: "Submit the PR review at the pinned SHA (clears the request) and delete the claim marker.",
    parameters: Type.Object({ repo: Type.String(), pr: Type.Number(), event: Type.Union([Type.Literal("approve"), Type.Literal("request-changes"), Type.Literal("comment")]), summary: Type.String(), comments: Type.Optional(Type.Array(Type.Object({ path: Type.String(), line: Type.Number(), body: Type.String() }))) }),
    async execute(_id, p) { return ok(await completeReview({ gh: gh(), config: cfg() }, p)); } });

  pi.registerTool({ name: "review_enrich", label: "Enrich a review", description: "Post a consolidated second opinion once the primary exists; else waiting/promote.",
    parameters: Type.Object({ repo: Type.String(), pr: Type.Number(), verdict: Type.Union([Type.Literal("agree"), Type.Literal("disagree"), Type.Literal("mixed")]), summary: Type.String(), newFindings: Type.Optional(Type.Array(Type.Object({ path: Type.String(), line: Type.Number(), body: Type.String() }))) }),
    async execute(_id, p) { return ok(await enrichReview({ gh: gh(), config: cfg(), ttlMs: 30 * 60_000, nowMs: Date.now() }, { repo: p.repo, pr: p.pr, overallVerdict: p.verdict, summary: p.summary, newFindings: p.newFindings })); } });

  pi.registerTool({ name: "labels_bootstrap", label: "Bootstrap labels", description: "Idempotently create/update the agent + skill labels.",
    parameters: Type.Object({ repo: Type.String() }),
    async execute(_id, p) { return ok(await bootstrap(gh(), { repo: p.repo })); } });
}

export default function (pi: ExtensionAPI): void {
  registerTools(pi);
}
