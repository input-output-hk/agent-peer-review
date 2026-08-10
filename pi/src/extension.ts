import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { hostname } from "node:os";
import {
  loadConfig, OctokitGateway, createReview, listReviews, claimReview, completeReview, enrichReview, bootstrap,
  stabilize, expedite, requestPeerReview, approveDependencyUpgrade, watchAndReReview, DEFAULT_GATE_POLICY,
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

  pi.registerTool({ name: "review_create", label: "Request a review", description: "Add the ai-review label + skill labels and request reviewer(s) (defaults to the configured \"reviewers\" when omitted).",
    parameters: Type.Object({ repo: Type.String(), pr: Type.Number(), skills: Type.Optional(Type.Array(Type.String())), reviewers: Type.Optional(Type.Array(Type.String({ minLength: 1 }))), note: Type.Optional(Type.String()) }),
    async execute(_id, p) {
      const reviewers = p.reviewers?.length ? p.reviewers : cfg().reviewers;
      if (reviewers.length === 0) {
        throw new Error('No reviewers: pass "reviewers" or set a default "reviewers" in ~/.agent-peer-review/config.json');
      }
      return ok(await createReview(gh(), { repo: p.repo, pr: p.pr, skills: p.skills ?? [], reviewers, note: p.note }));
    } });

  pi.registerTool({ name: "review_list", label: "List review requests", description: "Open PRs labeled ai-review requested from a login (defaults to yours).",
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

  pi.registerTool({ name: "labels_bootstrap", label: "Bootstrap labels", description: "Idempotently create/update the ai-review + skill labels.",
    parameters: Type.Object({ repo: Type.String() }),
    async execute(_id, p) { return ok(await bootstrap(gh(), { repo: p.repo })); } });

  pi.registerTool({ name: "pr_stabilize", label: "Stabilize a PR", description: "Sync a PR with its base branch.",
    parameters: Type.Object({ repo: Type.String(), pr: Type.Number() }),
    async execute(_id, p) { return ok(await stabilize(gh(), { repo: p.repo, pr: p.pr })); } });

  // pr_expedite and pr_approve_dep_upgrade below both take "autonomy" as an explicit tool
  // parameter, defaulting to "propose", and NEVER read it from the global config. Whether a repo
  // (or change class) may auto-merge is per-repo flow configuration (Task 2's pi-taskflow flows),
  // so a global config flag can never silently switch every repo it touches into auto-merge.
  pi.registerTool({
    name: "pr_expedite",
    label: "Expedite a PR",
    description: "Evaluate the expedition gate; propose (default) or, only when explicitly asked, auto-merge a trivial change.",
    parameters: Type.Object({
      repo: Type.String(),
      pr: Type.Number(),
      autonomy: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("propose")])),
      mergeMethod: Type.Optional(Type.Union([Type.Literal("merge"), Type.Literal("squash"), Type.Literal("rebase")])),
      maxFiles: Type.Optional(Type.Integer({
        minimum: 1,
        description: `At most the default max files cap (${DEFAULT_GATE_POLICY.maxFiles}); narrows the size rail, never widens it.`,
      })),
      maxLines: Type.Optional(Type.Integer({
        minimum: 1,
        description: `At most the default max lines cap (${DEFAULT_GATE_POLICY.maxLines}); narrows the size rail, never widens it.`,
      })),
    }),
    async execute(_id, p) {
      // Clamped, never widened: a maxFiles/maxLines the caller supplies can only tighten the
      // default size rail. Widening the blast-radius cap is a human/config decision, not
      // something the calling model may grant itself in the same call that requests a merge.
      const policy = p.maxFiles !== undefined || p.maxLines !== undefined
        ? {
          maxFiles: p.maxFiles === undefined ? undefined : Math.min(p.maxFiles, DEFAULT_GATE_POLICY.maxFiles),
          maxLines: p.maxLines === undefined ? undefined : Math.min(p.maxLines, DEFAULT_GATE_POLICY.maxLines),
        }
        : undefined;
      return ok(await expedite(gh(), {
        repo: p.repo, pr: p.pr, now: new Date().toISOString(),
        autonomy: p.autonomy ?? "propose", mergeMethod: p.mergeMethod, policy,
        knownAgentLogins: cfg().knownAgentLogins,
      }));
    },
  });

  pi.registerTool({
    name: "pr_request_review", label: "Request a peer review",
    description: "Request an agent peer review (idempotent); reviewers default to the configured \"reviewers\" when omitted.",
    parameters: Type.Object({
      repo: Type.String(), pr: Type.Number(),
      skills: Type.Optional(Type.Array(Type.String())),
      reviewers: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    }),
    async execute(_id, p) {
      const reviewers = p.reviewers?.length ? p.reviewers : cfg().reviewers;
      if (reviewers.length === 0) {
        throw new Error('No reviewers: pass "reviewers" or set a default "reviewers" in ~/.agent-peer-review/config.json');
      }
      return ok(await requestPeerReview(gh(), { repo: p.repo, pr: p.pr, reviewers, skills: p.skills }));
    },
  });

  // See the note above pr_expedite: autonomy is an explicit parameter here too, defaulting to
  // "propose", and is never read from the global config.
  pi.registerTool({
    name: "pr_approve_dep_upgrade",
    label: "Approve a dependency upgrade",
    description: "Evaluate a bot dependency-upgrade PR; propose (default) or, only when explicitly asked, approve and merge.",
    parameters: Type.Object({
      repo: Type.String(),
      pr: Type.Number(),
      autonomy: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("propose")])),
      mergeMethod: Type.Optional(Type.Union([Type.Literal("merge"), Type.Literal("squash"), Type.Literal("rebase")])),
      botAllowlist: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    }),
    async execute(_id, p) {
      return ok(await approveDependencyUpgrade(gh(), {
        repo: p.repo, pr: p.pr, now: new Date().toISOString(),
        autonomy: p.autonomy ?? "propose", mergeMethod: p.mergeMethod, botAllowlist: p.botAllowlist,
        knownAgentLogins: cfg().knownAgentLogins,
      }));
    },
  });

  pi.registerTool({
    name: "pr_watch",
    label: "Watch a reviewed PR",
    description: "Decide the reviewer watch action for a PR I reviewed (re-review / wait / hold-for-human / abandoned / approved / none).",
    parameters: Type.Object({ repo: Type.String(), pr: Type.Number(), maxReviewRounds: Type.Optional(Type.Integer({ minimum: 1 })) }),
    async execute(_id, p) {
      // Same login resolution as the CLI: the configured login wins, falling back to the token's
      // own login. A single gateway instance is reused for both calls: the default deps.gh
      // factory (`() => new OctokitGateway()`) builds a brand-new client on every call, so
      // calling gh() twice here would resolve the login on one client and act on another.
      const github = gh();
      const config = cfg();
      const myLogin = config.githubLogin ?? await github.getAuthenticatedLogin();
      return ok(await watchAndReReview(github, {
        repo: p.repo, pr: p.pr, myLogin, maxReviewRounds: p.maxReviewRounds, knownAgentLogins: config.knownAgentLogins,
      }));
    },
  });
}

export default function (pi: ExtensionAPI): void {
  registerTools(pi);
}
