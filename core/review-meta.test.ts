import { describe, it, expect } from "vitest";
import { serializeMeta, parseMeta } from "./review-meta.js";

describe("review-meta", () => {
  it("round-trips through a review body", () => {
    const meta = {
      v: 1 as const,
      model: "claude-opus-4-8",
      agent: "claude-code",
      toolVersion: "1.2.3",
      role: "primary" as const,
      verdict: "approve",
      claimedAt: "2026-08-03T00:00:00Z",
      machine: "mbp-01",
      drifted: false,
    };
    const body = `looks good\n\n${serializeMeta(meta)}`;
    expect(parseMeta(body)).toEqual(meta);
  });

  it("returns null when there is no footer", () => {
    expect(parseMeta("plain review")).toBeNull();
  });

  it("finds the footer even when a PRIMARY_MARKER follows it", () => {
    const meta = { v: 1 as const, role: "primary" as const, verdict: "comment" };
    expect(parseMeta(`x\n\n${serializeMeta(meta)}\n\n<!-- agent-review:primary -->`)).toMatchObject({
      role: "primary",
      verdict: "comment",
    });
  });
});
