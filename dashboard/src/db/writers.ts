import type { DB } from "./open.js";
import type { PullRequest } from "@input-output-hk/agent-review";

export interface ReviewRow {
  githubReviewId: number; authorLogin: string; isPrimary: number; role: string | null; verdict: string | null;
  summary: string; commitId: string; submittedAt: string;
  model: string | null; agent: string | null; toolVersion: string | null; machine: string | null; claimedAt: string | null; drifted: number | null;
}
export interface NoteRow { githubCommentId: number; path: string; line: number | null; body: string; authorLogin: string; }
export interface ClaimRow { reviewerLogin: string; machine: string; sha: string; claimedAt: string; model: string | null; agent: string | null; toolVersion: string | null; }
export interface ParticipantRow { login: string; role: "author" | "reviewer"; }
export interface SyncRunRow { startedAt: string; finishedAt: string; repos: string[]; counts: Record<string, number>; ok: boolean; }

export function upsertRepo(db: DB, owner: string, name: string): number {
  const row = db
    .prepare("INSERT INTO repo(owner,name) VALUES(?,?) ON CONFLICT(owner,name) DO UPDATE SET name=excluded.name RETURNING id")
    .get(owner, name) as { id: number };
  return row.id;
}

export function upsertPull(db: DB, repoId: number, p: PullRequest): number {
  const row = db
    .prepare(
      `INSERT INTO pull_request(repo_id,number,title,author_login,state,url,head_sha,base_sha,created_at,updated_at,merged_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(repo_id,number) DO UPDATE SET
         title=excluded.title, author_login=excluded.author_login, state=excluded.state, url=excluded.url,
         head_sha=excluded.head_sha, base_sha=excluded.base_sha,
         created_at=excluded.created_at, updated_at=excluded.updated_at, merged_at=excluded.merged_at
       RETURNING id`,
    )
    .get(repoId, p.number, p.title, p.author, p.state, p.url, p.headSha, p.baseSha, p.createdAt, p.updatedAt, p.mergedAt) as { id: number };
  return row.id;
}

export function replaceChildren(
  db: DB,
  prId: number,
  data: { reviews: ReviewRow[]; notes: NoteRow[]; claims: ClaimRow[]; participants: ParticipantRow[] },
): void {
  const delReview = db.prepare("DELETE FROM review WHERE pr_id=?");
  const delNote = db.prepare("DELETE FROM review_note WHERE pr_id=?");
  const delClaim = db.prepare("DELETE FROM claim WHERE pr_id=?");
  const delPart = db.prepare("DELETE FROM participant WHERE pr_id=?");
  const insReview = db.prepare(
    `INSERT INTO review(pr_id,github_review_id,author_login,is_primary,role,verdict,summary,commit_id,submitted_at,model,agent,tool_version,machine,claimed_at,drifted)
     VALUES(@prId,@githubReviewId,@authorLogin,@isPrimary,@role,@verdict,@summary,@commitId,@submittedAt,@model,@agent,@toolVersion,@machine,@claimedAt,@drifted)`,
  );
  const insNote = db.prepare(
    "INSERT INTO review_note(pr_id,github_comment_id,path,line,body,author_login) VALUES(@prId,@githubCommentId,@path,@line,@body,@authorLogin)",
  );
  const insClaim = db.prepare(
    "INSERT INTO claim(pr_id,reviewer_login,machine,sha,claimed_at,model,agent,tool_version) VALUES(@prId,@reviewerLogin,@machine,@sha,@claimedAt,@model,@agent,@toolVersion)",
  );
  const insPart = db.prepare("INSERT INTO participant(pr_id,login,role) VALUES(@prId,@login,@role)");

  const tx = db.transaction(() => {
    delReview.run(prId); delNote.run(prId); delClaim.run(prId); delPart.run(prId);
    for (const r of data.reviews) insReview.run({ prId, ...r });
    for (const n of data.notes) insNote.run({ prId, ...n });
    for (const c of data.claims) insClaim.run({ prId, ...c });
    for (const p of data.participants) insPart.run({ prId, ...p });
  });
  tx();
}

export function recordSyncRun(db: DB, run: SyncRunRow): void {
  db.prepare("INSERT INTO sync_run(started_at,finished_at,repos_json,counts_json,ok) VALUES(?,?,?,?,?)").run(
    run.startedAt, run.finishedAt, JSON.stringify(run.repos), JSON.stringify(run.counts), run.ok ? 1 : 0,
  );
}
