/**
 * A titled card showing a sparkline of review activity per day. Point positions come entirely
 * from `timelineSpecs`; this component only draws the polyline/points it is given and a small
 * date-range caption.
 */
import { timelineSpecs } from "../charts";
import type { TimelineDatum } from "../charts";
import { shortDate } from "../format";

export interface ActivityChartProps {
  data: TimelineDatum[];
}

const WIDTH = 480;
const HEIGHT = 80;

export function ActivityChart({ data }: ActivityChartProps) {
  if (data.length === 0) {
    return (
      <div className="card">
        <h3>Activity</h3>
        <p style={{ color: "var(--muted)" }}>No activity yet.</p>
      </div>
    );
  }

  const { points, path } = timelineSpecs(data, { width: WIDTH, height: HEIGHT });
  const first = data[0]!;
  const last = data[data.length - 1]!;

  return (
    <div className="card">
      <h3>Activity</h3>
      <svg role="img" aria-label="Reviews per day" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width="100%" height={HEIGHT}>
        <polyline points={path} fill="none" stroke="var(--primary)" strokeWidth={2} />
        {points.map((point, index) => (
          <circle key={`${data[index]!.day}-${index}`} cx={point.x} cy={point.y} r={3} fill="var(--primary)" />
        ))}
      </svg>
      <p style={{ margin: "0.5rem 0 0", color: "var(--muted)", fontSize: "0.875rem" }}>
        {shortDate(first.day)} to {shortDate(last.day)}
      </p>
    </div>
  );
}
