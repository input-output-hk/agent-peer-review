import type { Overview, RepoSummary, PullSummary, PullDetail, SyncRun } from "./types";

/** Fetch `path` (same-origin) and parse the JSON body; throws on a non-2xx response. */
async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`GET ${path} failed with status ${res.status}`);
  }
  return (await res.json()) as T;
}

export function getOverview(): Promise<Overview> {
  return get<Overview>("/api/overview");
}

export function listRepos(): Promise<RepoSummary[]> {
  return get<RepoSummary[]>("/api/repos");
}

export function listPulls(owner: string, name: string): Promise<PullSummary[]> {
  return get<PullSummary[]>(`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls`);
}

export function getPullDetail(owner: string, name: string, number: number): Promise<PullDetail> {
  const path = `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${encodeURIComponent(String(number))}`;
  return get<PullDetail>(path);
}

export function listSyncRuns(): Promise<SyncRun[]> {
  return get<SyncRun[]>("/api/sync-runs");
}
