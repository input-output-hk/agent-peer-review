import { describe, it, expect } from "vitest";
import { serializeMarker, parseMarkers } from "./claim-marker.js";

const marker = { v: 1 as const, reviewer: "yshyn-iohk", machine: "mbp-01", sha: "abc1234", claimedAt: "2026-07-29T10:12:00Z" };

describe("claim marker", () => {
  it("round-trips through a comment body", () => {
    const parsed = parseMarkers([{ id: 1, body: serializeMarker(marker), author: "yshyn-iohk" }]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].marker).toEqual(marker);
  });
  it("ignores comments without a valid marker", () => {
    expect(parseMarkers([{ id: 2, body: "just a comment", author: "x" }])).toHaveLength(0);
    expect(parseMarkers([{ id: 3, body: "<!-- agent-review:claim {not json} -->", author: "x" }])).toHaveLength(0);
  });
});
