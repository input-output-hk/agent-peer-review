import { describe, it, expect } from "vitest";
import { ReviewResultSchema, ReviewRequestSchema, ClaimMarkerSchema, ConfigSchema } from "./model.js";

describe("model", () => {
  it("requires at least one reviewer on a request", () => {
    expect(() => ReviewRequestSchema.parse({ repo: "o/r", pr: 1, reviewers: [] })).toThrow();
    const ok = ReviewRequestSchema.parse({ repo: "o/r", pr: 1, reviewers: ["yshyn-iohk"] });
    expect(ok.skills).toEqual([]);
  });
  it("rejects an unknown review event", () => {
    expect(() => ReviewResultSchema.parse({ repo: "o/r", pr: 1, event: "nope", summary: "x" })).toThrow();
  });
  it("requires claim marker version 1", () => {
    expect(() => ClaimMarkerSchema.parse({ v: 2, reviewer: "y", machine: "m", sha: "abcdefg", claimedAt: "t" })).toThrow();
  });
  it("config defaults are all optional", () => {
    const c = ConfigSchema.parse({});
    expect(c.githubLogin).toBeNull();
    expect(c.runChecks).toBe(false);
  });
});
