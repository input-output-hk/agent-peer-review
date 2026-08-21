import { describe, it, expect } from "vitest";
import { serializeMeta, PRIMARY_MARKER, type Review } from "@input-output-hk/agent-review";
import { verdictFromState, stripMarkers, deriveReviewFields, participantsOf } from "./map.js";

const review = (over: Partial<Review>): Review => ({
  id: 1, author: "bot", state: "COMMENTED", body: "", commitId: "abc1234", submittedAt: "2026-02-01T00:00:00Z", ...over,
});

describe("verdictFromState", () => {
  it("maps GitHub states to the primary vocabulary", () => {
    expect(verdictFromState("APPROVED")).toBe("approve");
    expect(verdictFromState("CHANGES_REQUESTED")).toBe("request-changes");
    expect(verdictFromState("COMMENTED")).toBe("comment");
    expect(verdictFromState("DISMISSED")).toBeNull();
  });
});

describe("deriveReviewFields", () => {
  it("reads role/verdict/model from the meta footer when present", () => {
    const footer = serializeMeta({ v: 1, role: "primary", verdict: "approve", model: "claude-opus-4-8", agent: "claude-code", machine: "mac", claimedAt: "2026-02-01T00:00:00Z", drifted: false });
    const body = `Looks good.\n\n${footer}\n\n${PRIMARY_MARKER}`;
    const d = deriveReviewFields(review({ body, state: "COMMENTED" }));
    expect(d.isPrimary).toBe(true);
    expect(d.role).toBe("primary");
    expect(d.verdict).toBe("approve");
    expect(d.model).toBe("claude-opus-4-8");
    expect(d.agent).toBe("claude-code");
    expect(d.machine).toBe("mac");
    expect(d.drifted).toBe(0);
    expect(d.summary).toBe("Looks good.");        // footer + primary marker stripped
    expect(d.summary).not.toContain("agent-review:meta");
    expect(d.summary).not.toContain("agent-review:primary");
  });

  it("falls back to state-derived verdict for a footerless primary", () => {
    const body = `Ship it.\n\n${PRIMARY_MARKER}`;
    const d = deriveReviewFields(review({ body, state: "APPROVED" }));
    expect(d.isPrimary).toBe(true);
    expect(d.role).toBe("primary");
    expect(d.verdict).toBe("approve");
    expect(d.model).toBeNull();
    expect(d.summary).toBe("Ship it.");
  });

  it("falls back to the prefix vocabulary for a footerless second opinion", () => {
    const d = deriveReviewFields(review({ body: "**Second opinion (disagree):** I'd hold off.", state: "COMMENTED" }));
    expect(d.isPrimary).toBe(false);
    expect(d.role).toBe("second-opinion");
    expect(d.verdict).toBe("disagree");
  });

  it("leaves verdict null when a footerless second opinion has no prefix", () => {
    const d = deriveReviewFields(review({ body: "Some free-form note.", state: "COMMENTED" }));
    expect(d.role).toBe("second-opinion");
    expect(d.verdict).toBeNull();
  });

  it("bounds the attacker-controlled second-opinion label", () => {
    const tooLong = "x".repeat(201);
    expect(deriveReviewFields(review({ body: `**Second opinion (${tooLong}):** body` })).verdict).toBeNull();
    expect(deriveReviewFields(review({ body: "**Second opinion (agree\nforged):** body" })).verdict).toBeNull();
  });
});

describe("stripMarkers", () => {
  it("strips multiple meta footers", () => {
    const f1 = serializeMeta({ v: 1, role: "primary", verdict: "approve" });
    const f2 = serializeMeta({ v: 1, role: "second-opinion", verdict: "agree" });
    const s = stripMarkers(`Text.\n\n${f1}\n\n${f2}`);
    expect(s).toBe("Text.");
    expect(s).not.toContain("agent-review:meta");
  });
});

describe("participantsOf", () => {
  it("returns the author plus distinct review authors", () => {
    const pull = { number: 1, title: "t", author: "alice", headSha: "h", baseSha: "b", url: "u", state: "open" as const, labels: [], createdAt: "c", updatedAt: "u", mergedAt: null };
    const ps = participantsOf(pull, [review({ author: "bot" }), review({ author: "bot" }), review({ author: "carol" })]);
    expect(ps).toContainEqual({ login: "alice", role: "author" });
    expect(ps.filter((p) => p.role === "reviewer").map((p) => p.login).sort()).toEqual(["bot", "carol"]);
    expect(ps.filter((p) => p.login === "bot")).toHaveLength(1); // deduped
  });
});
