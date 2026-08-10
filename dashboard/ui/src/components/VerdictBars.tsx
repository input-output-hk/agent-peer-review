/**
 * Compact horizontal bars for a verdict-count distribution (an agent's or collaborator's
 * `verdicts` map, or an agent's `agreement` bucket reshaped to the same `Record<string, number>`
 * shape). Unlike `BarList`, this never computes a share of an outside total: buckets need not
 * sum to a review count (a review with no verdict is excluded, see queries.ts's listAgents
 * JSDoc), so each bar's width is only relative to the largest count in THIS distribution, and
 * every bar shows its raw count as text, never a computed percentage.
 *
 * Bar color follows the semantic verdict palette (`verdictColor`): approve/agree render
 * success, request-changes/disagree render danger, comment/mixed render warning.
 */
import { verdictLabel, verdictColor } from "../format";

export interface VerdictBarsProps {
  verdicts: Record<string, number>;
}

const BAR_MAX_WIDTH = 72;
const BAR_HEIGHT = 8;
const LABEL_WIDTH = 92;

export function VerdictBars({ verdicts }: VerdictBarsProps) {
  const entries = Object.entries(verdicts).filter(([, count]) => count > 0);

  if (entries.length === 0) {
    return <span style={{ color: "var(--muted)" }}>No verdicts yet.</span>;
  }

  const maxCount = Math.max(...entries.map(([, count]) => count));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
      {entries.map(([verdict, count]) => (
        <div key={verdict} style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
          <span style={{ width: LABEL_WIDTH, fontSize: "0.75rem", color: "var(--muted)" }}>{verdictLabel(verdict)}</span>
          <span
            style={{
              display: "inline-block",
              height: BAR_HEIGHT,
              borderRadius: BAR_HEIGHT / 2,
              width: maxCount > 0 ? (count / maxCount) * BAR_MAX_WIDTH : 0,
              background: verdictColor(verdict),
            }}
          />
          <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>{count}</span>
        </div>
      ))}
    </div>
  );
}
