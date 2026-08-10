/**
 * Agent identities page: fetches `/api/agents` (optionally scoped by the repo filter) and
 * renders one row per (agent, model) identity captured on a review. The identity with neither
 * field captured ((null, null)) is the "unknown" bucket -- reviews posted without metadata
 * capture enabled, not a distinct agent -- and renders as "Unknown" with a muted note.
 */
import { useEffect, useState } from "react";
import { listAgents, listRepos } from "../api";
import type { AgentSummary, RepoSummary } from "../types";
import { humanizeDuration, relativeTime } from "../format";
import { VerdictBars } from "../components/VerdictBars";
import { RepoFilter } from "../components/RepoFilter";

type AgentsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; agents: AgentSummary[] };

const cell = { padding: "0.5rem", borderTop: "1px solid var(--border)" } as const;
const headCell = { textAlign: "left", padding: "0.5rem" } as const;

/** Display name for an (agent, model) identity pair; both null is the "no metadata captured" bucket. */
function identityLabel(agent: string | null, model: string | null): string {
  if (agent !== null && model !== null) return `${agent} (${model})`;
  return agent ?? model ?? "Unknown";
}

export function Agents() {
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [repo, setRepo] = useState<string | undefined>(undefined);
  const [state, setState] = useState<AgentsState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    // Best-effort: the repo filter just degrades to "All repositories" only if this fails.
    // The agents fetch below has its own error state for the page's primary content.
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
    listAgents(repo)
      .then((agents) => {
        if (!cancelled) setState({ status: "ready", agents });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : "Failed to load agents.";
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
        <h2 style={{ margin: 0 }}>Agents</h2>
        <RepoFilter repos={repos} value={repo} onChange={setRepo} />
      </div>

      {state.status === "loading" ? <p>Loading agents...</p> : null}

      {state.status === "error" ? (
        <div className="card" role="alert">
          <p style={{ margin: 0 }}>Failed to load agents: {state.message}</p>
        </div>
      ) : null}

      {state.status === "ready" ? (
        state.agents.length === 0 ? (
          <p style={{ color: "var(--muted)" }}>No reviews synced yet.</p>
        ) : (
          <div className="card">
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={headCell}>Agent</th>
                  <th style={{ ...headCell, textAlign: "right" }}>Reviews</th>
                  <th style={{ ...headCell, textAlign: "right" }}>Primaries</th>
                  <th style={{ ...headCell, textAlign: "right" }}>Enrichments</th>
                  <th
                    style={headCell}
                    title="Counts of reviews with a captured verdict; a review with no verdict is not counted in any bucket, so these need not add up to Reviews."
                  >
                    Verdicts
                  </th>
                  <th style={headCell} title="Derived from posted second-opinion reviews, not independently verified.">
                    Agreement
                  </th>
                  <th style={{ ...headCell, textAlign: "right" }}>Avg turnaround</th>
                  <th style={{ ...headCell, textAlign: "right" }}>Last active</th>
                  <th style={{ ...headCell, textAlign: "right" }}>Repos</th>
                </tr>
              </thead>
              <tbody>
                {state.agents.map((row) => (
                  <tr key={JSON.stringify([row.agent, row.model])}>
                    <td style={cell}>
                      <div>{identityLabel(row.agent, row.model)}</div>
                      {row.agent === null && row.model === null ? (
                        <div style={{ color: "var(--muted)", fontSize: "0.75rem" }}>
                          Reviews without captured agent/model metadata
                        </div>
                      ) : null}
                    </td>
                    <td style={{ ...cell, textAlign: "right" }}>{row.reviews}</td>
                    <td style={{ ...cell, textAlign: "right" }}>{row.primaries}</td>
                    <td style={{ ...cell, textAlign: "right" }}>{row.enrichments}</td>
                    <td style={cell}>
                      <VerdictBars verdicts={row.verdicts} />
                    </td>
                    <td style={cell}>
                      {row.agreement === null ? (
                        <span style={{ color: "var(--muted)" }}>No second opinions yet.</span>
                      ) : (
                        <VerdictBars
                          verdicts={{ agree: row.agreement.agree, disagree: row.agreement.disagree, mixed: row.agreement.mixed }}
                        />
                      )}
                    </td>
                    <td style={{ ...cell, textAlign: "right" }}>{humanizeDuration(row.avgTurnaroundSeconds)}</td>
                    <td style={{ ...cell, textAlign: "right" }}>{relativeTime(row.lastActiveAt)}</td>
                    <td style={{ ...cell, textAlign: "right" }}>{row.repos}</td>
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
