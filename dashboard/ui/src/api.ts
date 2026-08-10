import type { Overview, RepoSummary, PullSummary, PullDetail, SyncRun, AgentSummary, CollaboratorSummary } from "./types";

/** Fetch `path` (same-origin) and parse the JSON body; throws on a non-2xx response. */
async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`GET ${path} failed with status ${res.status}`);
  }
  return (await res.json()) as T;
}

/**
 * Builds the optional `?repo=` query suffix for `/api/agents` and `/api/collaborators`.
 * Omitted entirely when `repo` is undefined -- that is the "All repositories" contract (the
 * route also tolerates an empty value, but omitting the param is what the UI sends).
 */
function repoQuery(repo: string | undefined): string {
  return repo !== undefined ? `?repo=${encodeURIComponent(repo)}` : "";
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

/** Agent identities aggregated across reviews, optionally scoped to one repo ("owner/name"). */
export function listAgents(repo?: string): Promise<AgentSummary[]> {
  return get<{ agents: AgentSummary[] }>(`/api/agents${repoQuery(repo)}`).then((body) => body.agents);
}

/** Human collaborators (pull request authors), optionally scoped to one repo ("owner/name"). */
export function listCollaborators(repo?: string): Promise<CollaboratorSummary[]> {
  return get<{ collaborators: CollaboratorSummary[] }>(`/api/collaborators${repoQuery(repo)}`).then(
    (body) => body.collaborators,
  );
}
