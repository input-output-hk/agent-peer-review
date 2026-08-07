/** Repository list page: fetches `/api/repos` and renders each repo with its pull count and a link to its pulls route. */
import { useEffect, useState } from "react";
import { listRepos } from "../api";
import type { RepoSummary } from "../types";
import { Link } from "../router";

type ReposState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; repos: RepoSummary[] };

export function Repos() {
  const [state, setState] = useState<ReposState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    listRepos()
      .then((repos) => {
        if (!cancelled) setState({ status: "ready", repos });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : "Failed to load repositories.";
          setState({ status: "error", message });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") {
    return <p>Loading repositories...</p>;
  }

  if (state.status === "error") {
    return (
      <div className="card" role="alert">
        <p style={{ margin: 0 }}>Failed to load repositories: {state.message}</p>
      </div>
    );
  }

  const { repos } = state;

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <h2>Repositories</h2>
      {repos.length === 0 ? (
        <p style={{ color: "var(--muted)" }}>No repositories synced yet.</p>
      ) : (
        <div className="card">
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "0.5rem" }}>Repository</th>
                <th style={{ textAlign: "right", padding: "0.5rem" }}>Pulls</th>
              </tr>
            </thead>
            <tbody>
              {repos.map((repo) => (
                <tr key={`${repo.owner}/${repo.name}`}>
                  <td style={{ padding: "0.5rem", borderTop: "1px solid var(--border)" }}>
                    <Link to={`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`}>
                      {repo.owner}/{repo.name}
                    </Link>
                  </td>
                  <td style={{ padding: "0.5rem", textAlign: "right", borderTop: "1px solid var(--border)" }}>
                    {repo.pulls}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
