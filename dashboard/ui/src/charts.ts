/**
 * Pure SVG-geometry helpers for dashboard charts. No DOM, no React, no external chart
 * library: these functions compute plain coordinate data that a component turns into
 * `<svg>` markup (horizontal bar lists for verdict distribution / model usage, and an
 * activity sparkline).
 */

export interface BarDatum {
  label: string;
  count: number;
}

export interface BarChartOptions {
  width: number;
  barHeight: number;
  gap: number;
}

export interface BarSpec {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  count: number;
}

/**
 * One horizontal bar per datum, stacked top-to-bottom in input order. `y` stacks by
 * `(barHeight + gap) * index`; `width` scales linearly so the largest count fills
 * `opts.width` and a zero count collapses to zero width. When the input is empty or
 * every count is zero there is no divide-by-zero: widths are all 0.
 */
export function barSpecs(data: BarDatum[], opts: BarChartOptions): BarSpec[] {
  const maxCount = data.reduce((max, d) => Math.max(max, d.count), 0);
  return data.map((d, index) => ({
    x: 0,
    y: index * (opts.barHeight + opts.gap),
    width: maxCount > 0 ? (d.count / maxCount) * opts.width : 0,
    height: opts.barHeight,
    label: d.label,
    count: d.count,
  }));
}

export interface TimelineDatum {
  day: string;
  count: number;
}

export interface TimelineOptions {
  width: number;
  height: number;
}

export interface TimelinePoint {
  x: number;
  y: number;
}

export interface TimelineSpec {
  points: TimelinePoint[];
  path: string;
}

/**
 * Maps N `(day, count)` samples evenly across `opts.width` (`x = i/(n-1)*width`, or 0
 * when there is a single point) with `y = height - (count/maxCount)*height`, so the
 * highest count sits at the top (`y = 0`) and the lowest sits at the bottom
 * (`y = height`). `path` is an SVG polyline `points`-style string ("x,y x,y ..."). An
 * empty input returns no points and an empty path; when every count is zero there is
 * no divide-by-zero (all points sit at the bottom).
 */
export function timelineSpecs(data: TimelineDatum[], opts: TimelineOptions): TimelineSpec {
  if (data.length === 0) return { points: [], path: "" };

  const maxCount = data.reduce((max, d) => Math.max(max, d.count), 0);
  const lastIndex = data.length - 1;
  const points = data.map((d, index) => ({
    x: lastIndex === 0 ? 0 : (index / lastIndex) * opts.width,
    y: maxCount > 0 ? opts.height - (d.count / maxCount) * opts.height : opts.height,
  }));
  const path = points.map((p) => `${p.x},${p.y}`).join(" ");
  return { points, path };
}
