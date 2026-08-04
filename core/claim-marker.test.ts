import { describe, it, expect } from "vitest";
import { serializeMarker, parseMarkers, isPrimaryReview, PRIMARY_MARKER } from "./claim-marker.js";

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
  it("does not catastrophically backtrack on adversarial input (js/polynomial-redos)", () => {
    // Many repetitions of the marker prefix with no closing brace: the linear [^{}]* pattern
    // returns promptly (a lazy .*? was polynomial here). The test completing is the guard.
    const attack = "<!--agent-review:claim {".repeat(20000);
    expect(parseMarkers([{ id: 4, body: attack, author: "x" }])).toHaveLength(0);
  });
  it("isPrimaryReview matches only when the tag ends the body", () => {
    expect(isPrimaryReview(`summary\n\n${PRIMARY_MARKER}`)).toBe(true);
    expect(isPrimaryReview(`summary\n\n${PRIMARY_MARKER}\n`)).toBe(true); // trailing whitespace tolerated
    expect(isPrimaryReview(`I mention ${PRIMARY_MARKER} mid-body`)).toBe(false); // quoted, not a primary
    expect(isPrimaryReview("no tag at all")).toBe(false);
  });
  it("parses a v2 marker with model/agent metadata", () => {
    const m = {
      v: 2 as const,
      reviewer: "me",
      machine: "mbp",
      sha: "abc1234",
      claimedAt: "t",
      model: "claude-opus-4-8",
      agent: "claude-code",
      toolVersion: "1.0.0",
    };
    const parsed = parseMarkers([{ id: 1, body: serializeMarker(m), author: "me" }]);
    expect(parsed[0].marker).toEqual(m);
  });
});
