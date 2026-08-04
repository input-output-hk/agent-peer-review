import { describe, it, expect } from "vitest";
import { openDb } from "./open.js";
import { upsertRepo, upsertPull, replaceChildren, recordSyncRun } from "./writers.js";
import type { PullRequest } from "@input-output-hk/agent-review";

const pull = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 7, title: "Add X", author: "alice", headSha: "head123", baseSha: "base123",
  url: "https://gh/pr/7", state: "open", labels: ["agent"],
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", mergedAt: null, ...over,
});

describe("upsertRepo", () => {
  it("inserts once and returns a stable id", () => {
    const db = openDb(":memory:");
    const a = upsertRepo(db, "o", "r");
    const b = upsertRepo(db, "o", "r");
    expect(a).toBe(b);
    expect(db.prepare("SELECT COUNT(*) n FROM repo").get()).toEqual({ n: 1 });
  });
});

describe("upsertPull", () => {
  it("updates in place on the second sync (no duplicate row)", () => {
    const db = openDb(":memory:");
    const repoId = upsertRepo(db, "o", "r");
    const id1 = upsertPull(db, repoId, pull({ title: "old", state: "open" }));
    const id2 = upsertPull(db, repoId, pull({ title: "new", state: "merged", mergedAt: "2026-01-03T00:00:00Z" }));
    expect(id1).toBe(id2);
    const row: any = db.prepare("SELECT title, state, merged_at FROM pull_request WHERE id=?").get(id1);
    expect(row).toEqual({ title: "new", state: "merged", merged_at: "2026-01-03T00:00:00Z" });
    expect(db.prepare("SELECT COUNT(*) n FROM pull_request").get()).toEqual({ n: 1 });
  });
});

describe("replaceChildren", () => {
  it("replaces reviews/notes/claims/participants transactionally", () => {
    const db = openDb(":memory:");
    const repoId = upsertRepo(db, "o", "r");
    const prId = upsertPull(db, repoId, pull());

    replaceChildren(db, prId, {
      reviews: [{ githubReviewId: 100, authorLogin: "bot", isPrimary: 1, role: "primary", verdict: "approve",
        summary: "ok", commitId: "head123", submittedAt: "2026-01-02T01:00:00Z",
        model: "m", agent: "claude-code", toolVersion: "1", machine: "mac", claimedAt: "2026-01-02T00:00:00Z", drifted: 0 }],
      notes: [{ githubCommentId: 200, path: "a.ts", line: 5, body: "nit", authorLogin: "bot" }],
      claims: [{ reviewerLogin: "bot2", machine: "mac2", sha: "head123", claimedAt: "2026-01-02T00:30:00Z", model: null, agent: null, toolVersion: null }],
      participants: [{ login: "alice", role: "author" }, { login: "bot", role: "reviewer" }],
    });
    expect(db.prepare("SELECT COUNT(*) n FROM review").get()).toEqual({ n: 1 });

    // Second call with fewer children must delete the stale ones.
    replaceChildren(db, prId, { reviews: [], notes: [], claims: [], participants: [] });
    for (const t of ["review", "review_note", "claim", "participant"]) {
      expect(db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE pr_id=?`).get(prId)).toEqual({ n: 0 });
    }
  });
});

describe("recordSyncRun", () => {
  it("stores repos and counts as JSON with ok=1", () => {
    const db = openDb(":memory:");
    recordSyncRun(db, { startedAt: "s", finishedAt: "f", repos: ["o/r"], counts: { repos: 1, pulls: 2, reviews: 3, notes: 4, claims: 5 }, ok: true });
    const row: any = db.prepare("SELECT repos_json, counts_json, ok FROM sync_run").get();
    expect(JSON.parse(row.repos_json)).toEqual(["o/r"]);
    expect(JSON.parse(row.counts_json).reviews).toBe(3);
    expect(row.ok).toBe(1);
  });
});
