import { describe, it, expect } from "vitest";
import { ReviewResultSchema, ReviewRequestSchema, ClaimMarkerSchema, ConfigSchema, LabelSpecSchema } from "./model.js";

describe("model", () => {
  it("requires at least one reviewer on a request", () => {
    expect(() => ReviewRequestSchema.parse({ repo: "o/r", pr: 1, reviewers: [] })).toThrow();
    const ok = ReviewRequestSchema.parse({ repo: "o/r", pr: 1, reviewers: ["yshyn-iohk"] });
    expect(ok.skills).toEqual([]);
  });
  it("rejects an unknown review event", () => {
    expect(() => ReviewResultSchema.parse({ repo: "o/r", pr: 1, event: "nope", summary: "x" })).toThrow();
  });
  it("accepts a valid review result", () => {
    const ok = ReviewResultSchema.parse({ repo: "o/r", pr: 1, event: "approve", summary: "looks good" });
    expect(ok.event).toBe("approve");
  });
  it("requires claim marker version 1", () => {
    expect(() => ClaimMarkerSchema.parse({ v: 2, reviewer: "y", machine: "m", sha: "abcdefg", claimedAt: "t" })).toThrow();
  });
  it("accepts a valid claim marker", () => {
    const ok = ClaimMarkerSchema.parse({ v: 1, reviewer: "y", machine: "m", sha: "abcdefg", claimedAt: "t" });
    expect(ok.v).toBe(1);
  });
  it("config defaults are all optional", () => {
    const c = ConfigSchema.parse({});
    expect(c.githubLogin).toBeNull();
    expect(c.runChecks).toBe(false);
  });
  it("accepts a valid label spec", () => {
    const ok = LabelSpecSchema.parse({ name: "needs-review", color: "5319e7", description: "Needs another look" });
    expect(ok.color).toBe("5319e7");
  });
  it("rejects a label spec with a non-hex color", () => {
    expect(() => LabelSpecSchema.parse({ name: "needs-review", color: "xyz", description: "Needs another look" })).toThrow();
  });
});
