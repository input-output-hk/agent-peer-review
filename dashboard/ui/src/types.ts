/** Response shapes returned by the Phase 2 read-only dashboard API. Mirrors `dashboard/src/db/queries.ts`. */

export interface Overview {
  totals: { repos: number; pulls: number; reviews: number };
  verdicts: { verdict: string; count: number }[];
  models: { model: string; count: number }[];
  activity: { day: string; count: number }[];
  lastSync: { startedAt: string; finishedAt: string | null; ok: boolean; counts: Record<string, number> } | null;
}

export interface RepoSummary {
  owner: string;
  name: string;
  pulls: number;
}

export interface PullSummary {
  number: number;
  title: string;
  author: string;
  state: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  reviews: number;
  primaryVerdict: string | null;
}

export interface ReviewDetail {
  githubReviewId: number;
  author: string;
  isPrimary: boolean;
  role: string | null;
  verdict: string | null;
  summary: string;
  commitId: string;
  submittedAt: string;
  model: string | null;
  agent: string | null;
  toolVersion: string | null;
  machine: string | null;
  claimedAt: string | null;
  drifted: boolean | null;
}

export interface Note {
  path: string;
  line: number | null;
  body: string;
  author: string;
}

export interface Claim {
  reviewer: string;
  machine: string;
  sha: string;
  claimedAt: string;
  model: string | null;
  agent: string | null;
  toolVersion: string | null;
}

export interface Participant {
  login: string;
  role: string;
}

export interface PullDetail {
  pull: PullSummary & { headSha: string; baseSha: string; repo: { owner: string; name: string } };
  reviews: ReviewDetail[];
  notes: Note[];
  claims: Claim[];
  participants: Participant[];
}

export interface SyncRun {
  startedAt: string;
  finishedAt: string | null;
  ok: boolean;
  repos: string[];
  counts: Record<string, number>;
}
