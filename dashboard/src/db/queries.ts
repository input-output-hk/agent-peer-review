import type { DB } from "./open.js";

export interface Overview {
  totals: { repos: number; pulls: number; reviews: number };
  verdicts: Array<{ verdict: string; count: number }>;
  models: Array<{ model: string; count: number }>;
  activity: Array<{ day: string; count: number }>;
  lastSync: { startedAt: string; finishedAt: string | null; ok: boolean; counts: Record<string, number> } | null;
}
export interface RepoSummary { owner: string; name: string; pulls: number }
export interface PullSummary {
  number: number; title: string; author: string; state: string; url: string;
  createdAt: string; updatedAt: string; mergedAt: string | null; reviews: number; primaryVerdict: string | null;
}
export interface ReviewDetail {
  githubReviewId: number; author: string; isPrimary: boolean; role: string | null; verdict: string | null;
  summary: string; commitId: string; submittedAt: string;
  model: string | null; agent: string | null; toolVersion: string | null; machine: string | null; claimedAt: string | null; drifted: boolean | null;
}
export interface PullDetail {
  pull: PullSummary & { repo: { owner: string; name: string }; headSha: string; baseSha: string };
  reviews: ReviewDetail[];
  notes: Array<{ path: string; line: number | null; body: string; author: string }>;
  claims: Array<{ reviewer: string; machine: string; sha: string; claimedAt: string; model: string | null; agent: string | null; toolVersion: string | null }>;
  participants: Array<{ login: string; role: string }>;
}
export interface SyncRunRow { startedAt: string; finishedAt: string | null; ok: boolean; repos: string[]; counts: Record<string, number> }
export interface AgentAgreement { agree: number; disagree: number; mixed: number }
export interface AgentRow {
  agent: string | null; model: string | null; reviews: number; primaries: number; enrichments: number;
  verdicts: Record<string, number>; agreement: AgentAgreement | null;
  // Never null: every row here comes from >= 1 review, and submitted_at is NOT NULL in the schema.
  avgTurnaroundSeconds: number | null; lastActiveAt: string; repos: number;
}
export interface CollaboratorRow {
  login: string; pullsAuthored: number; reviewsReceived: number;
  verdicts: Record<string, number>; agentsSeen: number;
  // Never null: every row here comes from >= 1 pull, and pull_request.updated_at is NOT NULL.
  lastActivityAt: string;
}

export function getOverview(db: DB): Overview {
  const totals = db.prepare(
    "SELECT (SELECT COUNT(*) FROM repo) AS repos, (SELECT COUNT(*) FROM pull_request) AS pulls, (SELECT COUNT(*) FROM review) AS reviews",
  ).get() as { repos: number; pulls: number; reviews: number };
  const verdicts = db.prepare(
    "SELECT verdict, COUNT(*) AS count FROM review WHERE verdict IS NOT NULL GROUP BY verdict ORDER BY count DESC, verdict",
  ).all() as Array<{ verdict: string; count: number }>;
  const models = db.prepare(
    "SELECT COALESCE(model, 'unknown') AS model, COUNT(*) AS count FROM review GROUP BY COALESCE(model, 'unknown') ORDER BY count DESC, model",
  ).all() as Array<{ model: string; count: number }>;
  const activity = db.prepare(
    "SELECT substr(submitted_at, 1, 10) AS day, COUNT(*) AS count FROM review GROUP BY day ORDER BY day",
  ).all() as Array<{ day: string; count: number }>;
  const last = db.prepare(
    "SELECT started_at AS startedAt, finished_at AS finishedAt, ok, counts_json AS countsJson FROM sync_run ORDER BY id DESC LIMIT 1",
  ).get() as { startedAt: string; finishedAt: string | null; ok: number; countsJson: string | null } | undefined;
  return {
    totals, verdicts, models, activity,
    lastSync: last ? { startedAt: last.startedAt, finishedAt: last.finishedAt, ok: last.ok === 1, counts: last.countsJson ? JSON.parse(last.countsJson) : {} } : null,
  };
}

export function listRepos(db: DB): RepoSummary[] {
  return db.prepare(
    `SELECT r.owner, r.name, COUNT(p.id) AS pulls
       FROM repo r LEFT JOIN pull_request p ON p.repo_id = r.id
       GROUP BY r.id ORDER BY r.owner, r.name`,
  ).all() as RepoSummary[];
}

export function listPulls(db: DB, owner: string, name: string): PullSummary[] {
  return db.prepare(
    `SELECT p.number, p.title, p.author_login AS author, p.state, p.url,
            p.created_at AS createdAt, p.updated_at AS updatedAt, p.merged_at AS mergedAt,
            COUNT(rv.id) AS reviews,
            MAX(CASE WHEN rv.is_primary = 1 THEN rv.verdict END) AS primaryVerdict
       FROM pull_request p
       JOIN repo r ON r.id = p.repo_id
       LEFT JOIN review rv ON rv.pr_id = p.id
      WHERE r.owner = ? AND r.name = ?
      GROUP BY p.id ORDER BY p.updated_at DESC`,
  ).all(owner, name) as PullSummary[];
}

export function getPullDetail(db: DB, owner: string, name: string, number: number): PullDetail | null {
  const p = db.prepare(
    `SELECT p.id, p.number, p.title, p.author_login AS author, p.state, p.url,
            p.head_sha AS headSha, p.base_sha AS baseSha,
            p.created_at AS createdAt, p.updated_at AS updatedAt, p.merged_at AS mergedAt
       FROM pull_request p JOIN repo r ON r.id = p.repo_id
      WHERE r.owner = ? AND r.name = ? AND p.number = ?`,
  ).get(owner, name, number) as any;
  if (!p) return null;
  const reviews = (db.prepare(
    `SELECT github_review_id AS githubReviewId, author_login AS author, is_primary AS isPrimary, role, verdict,
            summary, commit_id AS commitId, submitted_at AS submittedAt, model, agent, tool_version AS toolVersion,
            machine, claimed_at AS claimedAt, drifted
       FROM review WHERE pr_id = ? ORDER BY submitted_at, id`,
  ).all(p.id) as any[]).map((r) => ({ ...r, isPrimary: r.isPrimary === 1, drifted: r.drifted === null ? null : r.drifted === 1 }));
  const notes = db.prepare(
    "SELECT path, line, body, author_login AS author FROM review_note WHERE pr_id = ? ORDER BY id",
  ).all(p.id) as PullDetail["notes"];
  const claims = db.prepare(
    "SELECT reviewer_login AS reviewer, machine, sha, claimed_at AS claimedAt, model, agent, tool_version AS toolVersion FROM claim WHERE pr_id = ? ORDER BY claimed_at",
  ).all(p.id) as PullDetail["claims"];
  const participants = db.prepare(
    "SELECT login, role FROM participant WHERE pr_id = ? ORDER BY role, login",
  ).all(p.id) as PullDetail["participants"];
  const { id, ...pullNoId } = p;
  return {
    pull: { ...pullNoId, reviews: reviews.length, primaryVerdict: reviews.find((r) => r.isPrimary)?.verdict ?? null, repo: { owner, name } },
    reviews, notes, claims, participants,
  };
}

export function listSyncRuns(db: DB, limit = 20): SyncRunRow[] {
  return (db.prepare(
    "SELECT started_at AS startedAt, finished_at AS finishedAt, ok, repos_json AS reposJson, counts_json AS countsJson FROM sync_run ORDER BY id DESC LIMIT ?",
  ).all(limit) as any[]).map((r) => ({
    startedAt: r.startedAt, finishedAt: r.finishedAt, ok: r.ok === 1,
    repos: JSON.parse(r.reposJson), counts: r.countsJson ? JSON.parse(r.countsJson) : {},
  }));
}

// --- Agents + collaborators aggregates (dashboard Phase 4) ---------------------------------

/**
 * Splits an `opts.repo` ("owner/name") filter into a SQL fragment plus its bind params; empty
 * (no filter applied) when `repo` is absent. Callers pass this straight into a template literal
 * and spread the params into `.all()`/`.get()`. The route layer (see routes.ts) validates the
 * owner/name shape before this is ever reached, so no shape-checking happens here -- same trust
 * level as sync.ts's own `repo.split("/")`.
 */
function repoFilterClause(repo: string | undefined): { sql: string; params: string[] } {
  if (!repo) return { sql: "", params: [] };
  const [owner, name] = repo.split("/");
  return { sql: "r.owner = ? AND r.name = ?", params: [owner, name] };
}

/** Joins non-empty SQL condition fragments into a `WHERE ... AND ...` clause, or "" when none apply. */
function whereClause(parts: ReadonlyArray<string>): string {
  const nonEmpty = parts.filter((p) => p.length > 0);
  return nonEmpty.length ? `WHERE ${nonEmpty.join(" AND ")}` : "";
}

/** Stable key for an (agent, model) identity pair; (null, null) groups together like SQL GROUP BY does. */
function identityKey(agent: string | null, model: string | null): string {
  return JSON.stringify([agent, model]);
}

/**
 * One row per agent identity, where identity is the (agent, model) pair captured on `review` rows
 * (see docs/metadata-capture.md); reviews with neither field captured collapse into a single
 * `(null, null)` "unknown" row, matching how `getOverview.models` merges NULL-model reviews.
 *
 * `primaries`/`enrichments` split by the `role` column ("primary" / "second-opinion"). `agreement`
 * is verdict-based, not role-based: it buckets whichever rows carry one of the three literal verdict
 * strings `enrichReview()` writes (agree/disagree/mixed; see `EnrichmentSchema.overallVerdict` in
 * core/model.ts), which is disjoint from `completeReview()`'s approve/request-changes/comment
 * vocabulary -- so a plain verdict-value match cleanly identifies genuine second-opinion reactions
 * even though a "second-opinion"-role row can also carry an ordinary completion verdict (a
 * completeReview() that lost the primary race; see core/operations/complete.ts's `competing`
 * branch). That disjointness is a convention enforced by those two call sites, NOT authenticated by
 * anything downstream: `ReviewMeta.verdict` (core/review-meta.ts) is an unconstrained
 * `z.string().min(1)`, and the pre-Phase-0/capture-off fallback that `map.ts`'s `deriveReviewFields`
 * uses instead scrapes the verdict straight out of the review body's `"**Second opinion (X):**"`
 * text with no vocabulary check at all. Anyone who can post a review body (or a hand-written
 * meta footer) can make `verdict` say anything, including "agree". `agreement`, like `verdicts`, is
 * reporting what the review body claims, not a verified fact. `agreement` is null when none occur.
 */
export function listAgents(db: DB, opts: { repo?: string } = {}): AgentRow[] {
  const rf = repoFilterClause(opts.repo);

  // Turnaround uses julianday (fractional days, full float precision), not strftime('%s') (whole
  // seconds only): claimedAt is an agent-side `new Date().toISOString()` with millisecond
  // precision, submittedAt is GitHub's whole-second timestamp, and flooring both to integer
  // seconds before subtracting biases the result upward by however much of the claim's second had
  // already elapsed (e.g. claimed at :00.900, submitted at :01.100 is a true 0.2s gap, but
  // strftime('%s', ...) floors the claim down a further 0.9s, reporting 1s). The scalar (2-argument)
  // MAX(0.0, ...) clamps a negative gap to 0: claimedAt and submittedAt come from two different
  // clocks (the reviewing agent's host and GitHub's server), and a fast local clock can otherwise
  // report a review as completed before it was claimed.
  const mainRows = db.prepare(`
    SELECT rv.agent AS agent, rv.model AS model,
           COUNT(*) AS reviews,
           COUNT(CASE WHEN rv.role = 'primary' THEN 1 END) AS primaries,
           COUNT(CASE WHEN rv.role = 'second-opinion' THEN 1 END) AS enrichments,
           AVG(CASE WHEN rv.claimed_at IS NOT NULL
                    THEN MAX(0.0, (julianday(rv.submitted_at) - julianday(rv.claimed_at)) * 86400.0)
               END) AS avgTurnaroundSeconds,
           MAX(rv.submitted_at) AS lastActiveAt,
           COUNT(DISTINCT p.repo_id) AS repos
      FROM review rv
      JOIN pull_request p ON p.id = rv.pr_id
      JOIN repo r ON r.id = p.repo_id
      ${whereClause([rf.sql])}
     GROUP BY rv.agent, rv.model
     ORDER BY reviews DESC, lastActiveAt DESC, agent, model
  `).all(...rf.params) as Array<{
    agent: string | null; model: string | null; reviews: number; primaries: number; enrichments: number;
    avgTurnaroundSeconds: number | null; lastActiveAt: string; repos: number;
  }>;

  const verdictRows = db.prepare(`
    SELECT rv.agent AS agent, rv.model AS model, rv.verdict AS verdict, COUNT(*) AS count
      FROM review rv
      JOIN pull_request p ON p.id = rv.pr_id
      JOIN repo r ON r.id = p.repo_id
      ${whereClause([rf.sql, "rv.verdict IS NOT NULL"])}
     GROUP BY rv.agent, rv.model, rv.verdict
  `).all(...rf.params) as Array<{ agent: string | null; model: string | null; verdict: string; count: number }>;

  // Buckets are built as Maps, not plain objects: `verdict` is attacker-controllable free text (see
  // the JSDoc above), and a plain-object `bucket[verdict] = count` silently drops a verdict literally
  // named "__proto__" (the assignment hits Object.prototype's inherited __proto__ setter instead of
  // creating an own property, and since `count` is a number rather than an object, that setter is a
  // silent no-op). Object.fromEntries on a Map does not have this problem: it defines the property
  // directly rather than going through `[[Set]]`.
  const verdictsByIdentity = new Map<string, Map<string, number>>();
  for (const { agent, model, verdict, count } of verdictRows) {
    const key = identityKey(agent, model);
    const bucket = verdictsByIdentity.get(key) ?? new Map<string, number>();
    bucket.set(verdict, count);
    verdictsByIdentity.set(key, bucket);
  }

  return mainRows.map((row) => {
    const verdictMap = verdictsByIdentity.get(identityKey(row.agent, row.model)) ?? new Map<string, number>();
    const agree = verdictMap.get("agree") ?? 0;
    const disagree = verdictMap.get("disagree") ?? 0;
    const mixed = verdictMap.get("mixed") ?? 0;
    return {
      agent: row.agent, model: row.model, reviews: row.reviews, primaries: row.primaries, enrichments: row.enrichments,
      verdicts: Object.fromEntries(verdictMap), agreement: agree + disagree + mixed > 0 ? { agree, disagree, mixed } : null,
      avgTurnaroundSeconds: row.avgTurnaroundSeconds, lastActiveAt: row.lastActiveAt, repos: row.repos,
    };
  });
}

/**
 * One row per human collaborator, identified as a pull-request author (`pull_request.author_login`;
 * `participant` never records a distinct "requester" role -- see map.ts's `participantsOf`, whose
 * only roles are "author" and "reviewer" -- so there is nothing to add beyond authorship). Every
 * author_login is included; the schema has no bot/human flag to filter on (`knownAgentLogins` is a
 * runtime config list for the expedition safety gate, never written to this database), so excluding
 * agent-looking logins here would be invented, not derived. `agentsSeen` counts distinct (agent,
 * model) identities (same identity definition as `listAgents`) seen among reviews on the
 * collaborator's pulls, excluding the (null, null) "unknown" identity since that may just as well
 * be an unannotated human review.
 */
export function listCollaborators(db: DB, opts: { repo?: string } = {}): CollaboratorRow[] {
  const rf = repoFilterClause(opts.repo);

  // The CASE spells out "greatest of the two MAX()es" by hand rather than calling SQLite's
  // scalar MAX(x, y): that two-or-more-argument form returns NULL if EITHER argument is NULL, so
  // it would silently collapse to NULL for any author whose pulls have zero reviews (a LEFT JOIN
  // with no matching review makes MAX(rv.submitted_at) NULL). The aggregate MAX(column) used here
  // instead ignores NULLs, which is what "most recent of these, some of which may be unknown" needs.
  const mainRows = db.prepare(`
    SELECT p.author_login AS login,
           COUNT(DISTINCT p.id) AS pullsAuthored,
           COUNT(rv.id) AS reviewsReceived,
           CASE WHEN MAX(rv.submitted_at) IS NOT NULL AND MAX(rv.submitted_at) > MAX(p.updated_at)
                THEN MAX(rv.submitted_at) ELSE MAX(p.updated_at) END AS lastActivityAt
      FROM pull_request p
      JOIN repo r ON r.id = p.repo_id
      LEFT JOIN review rv ON rv.pr_id = p.id
      ${whereClause([rf.sql])}
     GROUP BY p.author_login
     ORDER BY pullsAuthored DESC, lastActivityAt DESC, login
  `).all(...rf.params) as Array<{ login: string; pullsAuthored: number; reviewsReceived: number; lastActivityAt: string }>;

  const verdictRows = db.prepare(`
    SELECT p.author_login AS login, rv.verdict AS verdict, COUNT(*) AS count
      FROM pull_request p
      JOIN repo r ON r.id = p.repo_id
      JOIN review rv ON rv.pr_id = p.id
      ${whereClause([rf.sql, "rv.verdict IS NOT NULL"])}
     GROUP BY p.author_login, rv.verdict
  `).all(...rf.params) as Array<{ login: string; verdict: string; count: number }>;

  const agentIdentityRows = db.prepare(`
    SELECT p.author_login AS login, rv.agent AS agent, rv.model AS model
      FROM pull_request p
      JOIN repo r ON r.id = p.repo_id
      JOIN review rv ON rv.pr_id = p.id
      ${whereClause([rf.sql, "(rv.agent IS NOT NULL OR rv.model IS NOT NULL)"])}
     GROUP BY p.author_login, rv.agent, rv.model
  `).all(...rf.params) as Array<{ login: string; agent: string | null; model: string | null }>;

  // See listAgents' matching comment: Map, not a plain object, so a verdict literally named
  // "__proto__" (unvalidated body-scraped text; see listAgents' JSDoc) cannot be silently dropped.
  const verdictsByLogin = new Map<string, Map<string, number>>();
  for (const { login, verdict, count } of verdictRows) {
    const bucket = verdictsByLogin.get(login) ?? new Map<string, number>();
    bucket.set(verdict, count);
    verdictsByLogin.set(login, bucket);
  }
  const agentsSeenByLogin = new Map<string, number>();
  for (const { login } of agentIdentityRows) {
    agentsSeenByLogin.set(login, (agentsSeenByLogin.get(login) ?? 0) + 1);
  }

  return mainRows.map((row) => ({
    login: row.login,
    pullsAuthored: row.pullsAuthored,
    reviewsReceived: row.reviewsReceived,
    verdicts: Object.fromEntries(verdictsByLogin.get(row.login) ?? []),
    agentsSeen: agentsSeenByLogin.get(row.login) ?? 0,
    lastActivityAt: row.lastActivityAt,
  }));
}
