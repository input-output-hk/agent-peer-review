/** Pull request list for one repository: fetches `/api/repos/:owner/:name/pulls` and renders a table. */
import { useEffect, useState } from "react";
import { listPulls } from "../api";
import type { PullSummary } from "../types";
import { shortDate, verdictLabel } from "../format";
import { Link } from "../router";

export interface RepoPullsProps {
  owner: string;
  name: string;
}

type RepoPullsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; pulls: PullSummary[] };

const cell = { padding: "0.5rem", borderTop: "1px solid var(--border)" } as const;
const headCell = { textAlign: "left", padding: "0.5rem" } as const;

export function RepoPulls({ owner, name }: RepoPullsProps) {
  const [state, setState] = useState<RepoPullsState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    listPulls(owner, name)
      .then((pulls) => {
        if (!cancelled) setState({ status: "ready", pulls });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : "Failed to load pull requests.";
          setState({ status: "error", message });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [owner, name]);

  if (state.status === "loading") {
    return <p>Loading pull requests...</p>;
  }

  if (state.status === "error") {
    return (
      <div className="card" role="alert">
        <p style={{ margin: 0 }}>Failed to load pull requests: {state.message}</p>
      </div>
    );
  }

  const { pulls } = state;
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <h2>
        {owner}/{name}
      </h2>
      {pulls.length === 0 ? (
        <p style={{ color: "var(--muted)" }}>No pull requests synced yet.</p>
      ) : (
        <div className="card">
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={headCell}>#</th>
                <th style={headCell}>Title</th>
                <th style={headCell}>Author</th>
                <th style={headCell}>State</th>
                <th style={headCell}>Verdict</th>
                <th style={{ ...headCell, textAlign: "right" }}>Reviews</th>
                <th style={{ ...headCell, textAlign: "right" }}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {pulls.map((pull) => (
                <tr key={pull.number}>
                  <td style={cell}>
                    <Link to={`${base}/pulls/${pull.number}`}>#{pull.number}</Link>
                  </td>
                  <td style={cell}>{pull.title}</td>
                  <td style={cell}>{pull.author}</td>
                  <td style={cell}>{pull.state}</td>
                  <td style={cell}>{verdictLabel(pull.primaryVerdict)}</td>
                  <td style={{ ...cell, textAlign: "right" }}>{pull.reviews}</td>
                  <td style={{ ...cell, textAlign: "right" }}>{shortDate(pull.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
