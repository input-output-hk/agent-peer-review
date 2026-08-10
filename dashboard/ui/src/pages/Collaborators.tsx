/**
 * Collaborators page: fetches `/api/collaborators` (optionally scoped by the repo filter) and
 * renders one row per pull-request author. `lastActivity` is deliberately NOT labeled "last
 * active": GitHub bumps a pull request's `updatedAt` on anyone's activity, so this is the last
 * touch on any of the collaborator's pulls, not necessarily something the collaborator did --
 * the column header's tooltip says so.
 */
import { useEffect, useState } from "react";
import { listCollaborators, listRepos } from "../api";
import type { CollaboratorSummary, RepoSummary } from "../types";
import { relativeTime } from "../format";
import { VerdictBars } from "../components/VerdictBars";
import { RepoFilter } from "../components/RepoFilter";

type CollaboratorsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; collaborators: CollaboratorSummary[] };

const cell = { padding: "0.5rem", borderTop: "1px solid var(--border)" } as const;
const headCell = { textAlign: "left", padding: "0.5rem" } as const;

export function Collaborators() {
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [repo, setRepo] = useState<string | undefined>(undefined);
  const [state, setState] = useState<CollaboratorsState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    // Best-effort: the repo filter just degrades to "All repositories" only if this fails.
    // The collaborators fetch below has its own error state for the page's primary content.
    listRepos()
      .then((data) => {
        if (!cancelled) setRepos(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    listCollaborators(repo)
      .then((collaborators) => {
        if (!cancelled) setState({ status: "ready", collaborators });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : "Failed to load collaborators.";
          setState({ status: "error", message });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [repo]);

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: "1rem" }}>
        <h2 style={{ margin: 0 }}>Collaborators</h2>
        <RepoFilter repos={repos} value={repo} onChange={setRepo} />
      </div>

      {state.status === "loading" ? <p>Loading collaborators...</p> : null}

      {state.status === "error" ? (
        <div className="card" role="alert">
          <p style={{ margin: 0 }}>Failed to load collaborators: {state.message}</p>
        </div>
      ) : null}

      {state.status === "ready" ? (
        state.collaborators.length === 0 ? (
          <p style={{ color: "var(--muted)" }}>No collaborators synced yet.</p>
        ) : (
          <div className="card">
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={headCell}>Collaborator</th>
                  <th style={{ ...headCell, textAlign: "right" }}>Pulls authored</th>
                  <th style={{ ...headCell, textAlign: "right" }}>Reviews received</th>
                  <th
                    style={headCell}
                    title="Counts of reviews with a captured verdict; a review with no verdict is not counted in any bucket, so these need not add up to Reviews received."
                  >
                    Verdicts received
                  </th>
                  <th
                    style={{ ...headCell, textAlign: "right" }}
                    title="Distinct agent+model identities with captured metadata seen among reviews on their pulls; reviews without captured metadata are not counted here."
                  >
                    Agents seen
                  </th>
                  <th
                    style={{ ...headCell, textAlign: "right" }}
                    title="Last activity on any of their pull requests -- GitHub updates this on anyone's activity, not just theirs."
                  >
                    Last activity
                  </th>
                </tr>
              </thead>
              <tbody>
                {state.collaborators.map((row) => (
                  <tr key={row.login}>
                    <td style={cell}>{row.login}</td>
                    <td style={{ ...cell, textAlign: "right" }}>{row.pullsAuthored}</td>
                    <td style={{ ...cell, textAlign: "right" }}>{row.reviewsReceived}</td>
                    <td style={cell}>
                      <VerdictBars verdicts={row.verdicts} />
                    </td>
                    <td style={{ ...cell, textAlign: "right" }}>{row.agentsSeen}</td>
                    <td style={{ ...cell, textAlign: "right" }}>{relativeTime(row.lastActivityAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </section>
  );
}
