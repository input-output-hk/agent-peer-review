import { describe, it, expect } from "vitest";
import { barSpecs, timelineSpecs } from "./charts";

describe("barSpecs", () => {
  it("scales the max count to the full width and a zero count to zero width", () => {
    const specs = barSpecs(
      [
        { label: "approve", count: 10 },
        { label: "comment", count: 0 },
        { label: "request-changes", count: 5 },
      ],
      { width: 200, barHeight: 20, gap: 4 },
    );
    expect(specs.map((s) => s.width)).toEqual([200, 0, 100]);
  });

  it("preserves input order and passes label/count through unchanged", () => {
    const specs = barSpecs(
      [
        { label: "b", count: 1 },
        { label: "a", count: 2 },
      ],
      { width: 100, barHeight: 20, gap: 4 },
    );
    expect(specs.map((s) => s.label)).toEqual(["b", "a"]);
    expect(specs.map((s) => s.count)).toEqual([1, 2]);
  });

  it("stacks bars top-to-bottom by (barHeight + gap) * index, all sharing barHeight and x=0", () => {
    const specs = barSpecs(
      [
        { label: "a", count: 1 },
        { label: "b", count: 1 },
        { label: "c", count: 1 },
      ],
      { width: 100, barHeight: 20, gap: 4 },
    );
    expect(specs.map((s) => s.y)).toEqual([0, 24, 48]);
    expect(specs.every((s) => s.height === 20 && s.x === 0)).toBe(true);
  });

  it("returns [] for an empty array without throwing", () => {
    expect(() => barSpecs([], { width: 100, barHeight: 20, gap: 4 })).not.toThrow();
    expect(barSpecs([], { width: 100, barHeight: 20, gap: 4 })).toEqual([]);
  });

  it("never divides by zero when every count is zero", () => {
    const specs = barSpecs(
      [
        { label: "a", count: 0 },
        { label: "b", count: 0 },
      ],
      { width: 100, barHeight: 20, gap: 4 },
    );
    expect(specs.map((s) => s.width)).toEqual([0, 0]);
    expect(specs.every((s) => Number.isFinite(s.width))).toBe(true);
  });
});

describe("timelineSpecs", () => {
  it("maps N days to N points within the viewbox, with the max-count day at the top", () => {
    const { points } = timelineSpecs(
      [
        { day: "2026-01-01", count: 2 },
        { day: "2026-01-02", count: 10 },
        { day: "2026-01-03", count: 0 },
      ],
      { width: 100, height: 50 },
    );
    expect(points).toHaveLength(3);
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(100);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(50);
    }
    expect(points[0]!.x).toBe(0);
    expect(points[2]!.x).toBe(100);
    expect(points[1]!.y).toBe(0); // the max count sits at the top
    expect(points[2]!.y).toBe(50); // the zero count sits at the bottom
  });

  it("builds path as the points joined \"x,y x,y ...\"", () => {
    const { points, path } = timelineSpecs(
      [
        { day: "2026-01-01", count: 1 },
        { day: "2026-01-02", count: 3 },
      ],
      { width: 10, height: 10 },
    );
    expect(path).toBe(points.map((p) => `${p.x},${p.y}`).join(" "));
  });

  it("places a single point at x=0", () => {
    const { points } = timelineSpecs([{ day: "2026-01-01", count: 5 }], { width: 100, height: 50 });
    expect(points).toEqual([{ x: 0, y: 0 }]);
  });

  it("returns empty points and an empty path for an empty array", () => {
    expect(() => timelineSpecs([], { width: 100, height: 50 })).not.toThrow();
    expect(timelineSpecs([], { width: 100, height: 50 })).toEqual({ points: [], path: "" });
  });

  it("never divides by zero when every count is zero", () => {
    const { points } = timelineSpecs(
      [
        { day: "2026-01-01", count: 0 },
        { day: "2026-01-02", count: 0 },
      ],
      { width: 100, height: 50 },
    );
    expect(points.every((p) => Number.isFinite(p.y))).toBe(true);
    expect(points.every((p) => p.y === 50)).toBe(true);
  });
});
