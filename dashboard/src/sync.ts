import { parseMarkers, sortMarkers } from "@input-output-hk/agent-review";
import type { DB } from "./db/open.js";
import type { SyncGateway } from "./sync-gateway.js";
import { deriveReviewFields, participantsOf } from "./map.js";
import { upsertRepo, upsertPull, replaceChildren, recordSyncRun, type ReviewRow, type NoteRow, type ClaimRow } from "./db/writers.js";

export interface SyncCounts { repos: number; pulls: number; reviews: number; notes: number; claims: number; }

export async function sync(
  gateway: SyncGateway,
  db: DB,
  repos: string[],
  opts: { login?: string } = {},
): Promise<{ ok: boolean; counts: SyncCounts }> {
  const login = opts.login ?? (await gateway.getAuthenticatedLogin());
  const startedAt = new Date().toISOString();
  const counts: SyncCounts = { repos: 0, pulls: 0, reviews: 0, notes: 0, claims: 0 };
  const uniqueRepos = [...new Set(repos)];

  for (const repo of uniqueRepos) {
    const [owner, name] = repo.split("/");
    const repoId = upsertRepo(db, owner, name);
    counts.repos++;

    const pulls = await gateway.findAgentPulls(repo, login);
    for (const pull of pulls) {
      const [reviews, notes, comments] = await Promise.all([
        gateway.getReviews(repo, pull.number),
        gateway.listReviewComments(repo, pull.number),
        gateway.listComments(repo, pull.number),
      ]);
      const claims = sortMarkers(parseMarkers(comments));

      const reviewRows: ReviewRow[] = reviews.map((r) => {
        const d = deriveReviewFields(r);
        return {
          githubReviewId: r.id, authorLogin: r.author, isPrimary: d.isPrimary ? 1 : 0, role: d.role, verdict: d.verdict,
          summary: d.summary, commitId: r.commitId, submittedAt: r.submittedAt,
          model: d.model, agent: d.agent, toolVersion: d.toolVersion, machine: d.machine, claimedAt: d.claimedAt, drifted: d.drifted,
        };
      });
      const noteRows: NoteRow[] = notes.map((n) => ({ githubCommentId: n.id, path: n.path, line: n.line, body: n.body, authorLogin: n.author }));
      // The claim table is UNIQUE(pr_id, reviewer_login): a raced/retried claim can leave two
      // markers naming the same reviewer, which would otherwise throw inside replaceChildren's
      // transaction and abort the whole sync (no repos synced, no sync_run recorded). `claims` is
      // ascending by claimedAt (sortMarkers), so building a Map keyed by reviewer and overwriting
      // on repeats keeps the LATEST claim per reviewer.
      const claimByReviewer = new Map<string, ClaimRow>();
      for (const { marker } of claims) {
        claimByReviewer.set(marker.reviewer, {
          reviewerLogin: marker.reviewer, machine: marker.machine, sha: marker.sha, claimedAt: marker.claimedAt,
          model: marker.model ?? null, agent: marker.agent ?? null, toolVersion: marker.toolVersion ?? null,
        });
      }
      const claimRows: ClaimRow[] = [...claimByReviewer.values()];

      const prId = upsertPull(db, repoId, pull);
      replaceChildren(db, prId, { reviews: reviewRows, notes: noteRows, claims: claimRows, participants: participantsOf(pull, reviews) });

      counts.pulls++;
      counts.reviews += reviewRows.length;
      counts.notes += noteRows.length;
      counts.claims += claimRows.length;
    }
  }

  recordSyncRun(db, { startedAt, finishedAt: new Date().toISOString(), repos, counts: { ...counts }, ok: true });
  return { ok: true, counts };
}
