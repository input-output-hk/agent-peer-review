/** A small banner reporting the outcome and timing of the most recent sync run. */
import type { Overview } from "../types";
import { relativeTime, shortDate } from "../format";

export interface LastSyncProps {
  lastSync: Overview["lastSync"];
}

export function LastSync({ lastSync }: LastSyncProps) {
  if (lastSync === null) {
    return (
      <div className="card">
        <p style={{ margin: 0 }}>No sync recorded yet.</p>
      </div>
    );
  }

  const { startedAt, finishedAt, ok, counts } = lastSync;
  const statusLabel = ok ? "Succeeded" : "Failed";
  const whenLabel = finishedAt !== null ? `finished ${relativeTime(finishedAt)}` : `started ${relativeTime(startedAt)}`;
  const countsSummary = Object.entries(counts)
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ");

  return (
    <div className="card">
      <p style={{ margin: 0 }}>
        Last sync <strong style={{ color: ok ? undefined : "var(--danger)" }}>{statusLabel}</strong>, {whenLabel}
      </p>
      <p style={{ margin: "0.25rem 0 0", color: "var(--muted)", fontSize: "0.875rem" }}>
        {shortDate(startedAt)}
        {countsSummary !== "" ? `, ${countsSummary}` : ""}
      </p>
    </div>
  );
}
