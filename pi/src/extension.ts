import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { hostname } from "node:os";
import {
  loadConfig, OctokitGateway, createReview, listReviews, claimReview, completeReview, enrichReview, bootstrap,
  stabilize, expedite, requestPeerReview, approveDependencyUpgrade, watchAndReReview,
  DEFAULT_GATE_POLICY, DEPS_GATE_POLICY, DEFAULT_MAX_REVIEW_ROUNDS,
  type GitHubGateway, type Config, type AllowedMergeMethods,
} from "@input-output-hk/agent-review";

// Same shape as mcp/server.ts's ok(), plus `details`: the real ExtensionAPI's
// `registerTool` requires `execute` to resolve `AgentToolResult<TDetails>`, and
// `AgentToolResult.details` is a required field. `{}` is a valid (empty) details
// payload; the model-facing content is unchanged.
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], details: {} });

// Memoizes a zero-argument factory so it runs at most once, the first time the wrapper is actually
// called, and every call after that returns the same value without re-running it. Exported so this
// primitive has a direct, network-free unit test; `defaultGh` below is its only real caller.
export function once<T>(factory: () => T): () => T {
  let value: T | undefined;
  let built = false;
  return () => {
    if (!built) { value = factory(); built = true; }
    return value as T;
  };
}

// The real default gateway, built at most once per process, lazily on first use, and reused by
// every tool call after that. Before this, `deps.gh ?? (() => new OctokitGateway())` built a brand
// new Octokit client, with an empty ETag conditional-request cache and no cached authenticated
// login, on every single tool call, so neither ever accumulated benefit across a run: under a
// taskflow's `concurrency: 4` that is a full, uncached `GET /user` plus a cold cache on every call.
// Only this default is memoized: an injected `deps.gh` (tests, or any future caller with its own
// lifecycle) is used exactly as given, call after call.
const defaultGh = once((): GitHubGateway => new OctokitGateway());

// Resolves the mergeMethod pr_expedite/pr_approve_dep_upgrade hand to the underlying operation when
// a call omits one. An explicit call-level mergeMethod always wins and short-circuits before any
// of this runs. Otherwise: a configured per-repo default (Config.mergeMethodByRepo) wins next,
// since it is a deliberate operator choice; then a best-effort read of which methods the repository
// itself currently allows, preferring "merge" (today's fallback) among whichever the repository
// permits. A repository pinned to squash-only or rebase-only merge policies otherwise 405s on
// every attempt, because both operations fall back to "merge" on an undefined mergeMethod. Any
// failure to learn better - a gateway without getAllowedMergeMethods, a transport error, or a
// repository that (surprisingly) permits none of the three - resolves to undefined, exactly
// today's behavior, rather than blocking the call.
async function resolveMergeMethod(
  gateway: GitHubGateway,
  config: Config,
  repo: string,
  explicit: "merge" | "squash" | "rebase" | undefined,
): Promise<"merge" | "squash" | "rebase" | undefined> {
  if (explicit !== undefined) return explicit;
  const configured = config.mergeMethodByRepo?.[repo];
  if (configured !== undefined) return configured;
  let allowed: AllowedMergeMethods | null | undefined;
  try {
    allowed = await gateway.getAllowedMergeMethods?.(repo);
  } catch {
    allowed = undefined;
  }
  if (!allowed) return undefined;
  if (allowed.merge) return "merge";
  if (allowed.squash) return "squash";
  if (allowed.rebase) return "rebase";
  return undefined;
}

export function registerTools(
  pi: ExtensionAPI,
  deps: { gh?: () => GitHubGateway; config?: () => Config } = {},
): void {
  const gh = deps.gh ?? defaultGh;
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
  // parameter, defaulting to "propose", and NEVER read it from the global config. Asking for a merge
  // is a per-invocation argument, not a setting: the shipped pr-requester/pr-reviewer/pr-steward
  // taskflows pass it down from their own `autonomy` flow argument (default "propose"), so it is
  // visible in the run that used it. A global config flag would instead switch every repository the
  // tool touches into auto-merge at once, silently, which is why no config path reaches this.
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
      // Captured once and reused below rather than calling gh()/cfg() again per use: keeps this
      // resilient to a caller injecting a non-memoized deps.gh, and avoids resolving the acting
      // login (inside expedite) against a different client than the one the merge-method probe
      // just read from.
      const github = gh();
      const config = cfg();
      // Only resolved when a merge might actually be attempted: in propose mode (the default),
      // mergeMethod is never read by the operation, so probing for it would just be an extra,
      // unused round trip on the common path.
      const mergeMethod = p.autonomy === "auto"
        ? await resolveMergeMethod(github, config, p.repo, p.mergeMethod)
        : p.mergeMethod;
      return ok(await expedite(github, {
        repo: p.repo, pr: p.pr, now: new Date().toISOString(),
        autonomy: p.autonomy ?? "propose", mergeMethod, policy,
        knownAgentLogins: config.knownAgentLogins,
      }));
    },
  });

  pi.registerTool({
    name: "pr_request_review", label: "Request a peer review",
    description: "Request an agent peer review (idempotent); reviewers default to the configured \"reviewers\" when omitted. Returns \"bot-authored\" and requests nothing on a bot-authored PR: that one belongs to pr_approve_dep_upgrade, which may approve it itself.",
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
    description: "Evaluate a bot dependency-upgrade PR; propose (default) or, only when explicitly asked, approve and merge. Returns approved-and-merged, approved (the approval landed but the merge did not), proposed, already-proposed, not-eligible, or blocked.",
    parameters: Type.Object({
      repo: Type.String(),
      pr: Type.Number(),
      autonomy: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("propose")])),
      mergeMethod: Type.Optional(Type.Union([Type.Literal("merge"), Type.Literal("squash"), Type.Literal("rebase")])),
      botAllowlist: Type.Optional(Type.Array(Type.String({
        minLength: 1,
        description: "Narrows the built-in dependency-bot allowlist; additional bot identities are ignored.",
      }))),
      maxFiles: Type.Optional(Type.Integer({
        minimum: 1,
        description: `At most the dependency policy's max files cap (${DEPS_GATE_POLICY.maxFiles}); narrows the size rail, never widens it.`,
      })),
      maxLines: Type.Optional(Type.Integer({
        minimum: 1,
        description: `At most the dependency policy's max lines cap (${DEPS_GATE_POLICY.maxLines}); narrows the size rail, never widens it.`,
      })),
    }),
    async execute(_id, p) {
      // Captured once so the merge-method probe (when it runs) and the operation itself share one
      // client, and resolved only when autonomy is "auto"; see the same note on pr_expedite.
      const github = gh();
      const config = cfg();
      const mergeMethod = p.autonomy === "auto"
        ? await resolveMergeMethod(github, config, p.repo, p.mergeMethod)
        : p.mergeMethod;
      // Clamped to the DEPENDENCY policy, the same tighten-only way pr_expedite clamps to the
      // general one: the operation's own default is DEPS_GATE_POLICY (a lockfile's line count is
      // mechanical churn, not reviewable surface), and a caller may narrow that but never widen it.
      const policy = p.maxFiles !== undefined || p.maxLines !== undefined
        ? {
          maxFiles: p.maxFiles === undefined ? undefined : Math.min(p.maxFiles, DEPS_GATE_POLICY.maxFiles),
          maxLines: p.maxLines === undefined ? undefined : Math.min(p.maxLines, DEPS_GATE_POLICY.maxLines),
        }
        : undefined;
      return ok(await approveDependencyUpgrade(github, {
        repo: p.repo, pr: p.pr, now: new Date().toISOString(),
        autonomy: p.autonomy ?? "propose", mergeMethod, botAllowlist: p.botAllowlist,
        policy,
        knownAgentLogins: config.knownAgentLogins,
      }));
    },
  });

  pi.registerTool({
    name: "pr_watch",
    label: "Watch a reviewed PR",
    description: "Decide the reviewer watch action for a PR I reviewed (re-review / wait / hold-for-human / abandoned / approved / none).",
    parameters: Type.Object({
      repo: Type.String(),
      pr: Type.Number(),
      maxReviewRounds: Type.Optional(Type.Integer({ minimum: 1, maximum: DEFAULT_MAX_REVIEW_ROUNDS })),
    }),
    async execute(_id, p) {
      // Same login resolution as the CLI: the configured login wins, falling back to the token's
      // own login. Captured once and reused for both calls below: relying on the default gh()
      // factory's per-process memoization (see defaultGh above) would happen to work today, but
      // capturing the reference locally keeps this correct even for a caller that injects its own,
      // non-memoized deps.gh, where calling gh() twice could resolve the login on one client and
      // act on another.
      const github = gh();
      const config = cfg();
      const myLogin = config.githubLogin ?? await github.getAuthenticatedLogin();
      return ok(await watchAndReReview(github, {
        repo: p.repo,
        pr: p.pr,
        myLogin,
        maxReviewRounds: p.maxReviewRounds === undefined
          ? undefined
          : Math.min(p.maxReviewRounds, DEFAULT_MAX_REVIEW_ROUNDS),
        knownAgentLogins: config.knownAgentLogins,
      }));
    },
  });
}

export default function (pi: ExtensionAPI): void {
  registerTools(pi);
}
