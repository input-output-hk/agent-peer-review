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

export function getOverview(db: DB): Overview {
  const totals = db.prepare(
    "SELECT (SELECT COUNT(*) FROM repo) AS repos, (SELECT COUNT(*) FROM pull_request) AS pulls, (SELECT COUNT(*) FROM review) AS reviews",
  ).get() as { repos: number; pulls: number; reviews: number };
  const verdicts = db.prepare(
    "SELECT verdict, COUNT(*) AS count FROM review WHERE verdict IS NOT NULL GROUP BY verdict ORDER BY count DESC, verdict",
  ).all() as Array<{ verdict: string; count: number }>;
  const models = db.prepare(
    "SELECT COALESCE(model, 'unknown') AS model, COUNT(*) AS count FROM review GROUP BY model ORDER BY count DESC, model",
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
