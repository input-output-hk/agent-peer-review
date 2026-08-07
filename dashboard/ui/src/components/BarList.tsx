/**
 * A titled card showing one horizontal bar per datum (verdict distribution, model usage).
 * Geometry (bar widths and vertical stacking) comes entirely from `barSpecs`; this component
 * only lays out the label and count text next to the bar it is given.
 */
import { barSpecs } from "../charts";
import type { BarDatum } from "../charts";

export interface BarListProps {
  title: string;
  data: BarDatum[];
}

const CHART_WIDTH = 160;
const BAR_HEIGHT = 14;
const GAP = 10;
const LABEL_WIDTH = 110;
const COUNT_MARGIN = 8;
const SVG_WIDTH = LABEL_WIDTH + CHART_WIDTH + 40;

export function BarList({ title, data }: BarListProps) {
  const specs = barSpecs(data, { width: CHART_WIDTH, barHeight: BAR_HEIGHT, gap: GAP });
  const svgHeight = specs.length === 0 ? 0 : specs[specs.length - 1]!.y + BAR_HEIGHT;

  return (
    <div className="card">
      <h3>{title}</h3>
      {data.length === 0 ? (
        <p style={{ color: "var(--muted)" }}>No data yet.</p>
      ) : (
        <svg role="img" aria-label={title} viewBox={`0 0 ${SVG_WIDTH} ${svgHeight}`} width="100%" height={svgHeight}>
          {specs.map((spec, index) => (
            <g key={`${spec.label}-${index}`}>
              <text x={spec.x} y={spec.y + spec.height / 2} dominantBaseline="middle" fontSize={13} fill="var(--fg)">
                {spec.label}
              </text>
              <rect x={LABEL_WIDTH + spec.x} y={spec.y} width={spec.width} height={spec.height} rx={3} fill="var(--primary)" />
              <text
                x={LABEL_WIDTH + CHART_WIDTH + COUNT_MARGIN}
                y={spec.y + spec.height / 2}
                dominantBaseline="middle"
                fontSize={13}
                fill="var(--muted)"
              >
                {spec.count}
              </text>
            </g>
          ))}
        </svg>
      )}
    </div>
  );
}
