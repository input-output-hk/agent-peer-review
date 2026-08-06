import { describe, it, expect } from "vitest";
import { shortDate, turnaround, verdictLabel, relativeTime } from "./format";

describe("shortDate", () => {
  it("returns a compact YYYY-MM-DD for a known ISO timestamp", () => {
    expect(shortDate("2026-01-02T10:30:00Z")).toBe("2026-01-02");
  });

  it("returns \"unknown\" for null", () => {
    expect(shortDate(null)).toBe("unknown");
  });

  it("returns \"unknown\" for an invalid timestamp", () => {
    expect(shortDate("not-a-date")).toBe("unknown");
  });
});

describe("turnaround", () => {
  it("formats hours and minutes for a known pair", () => {
    expect(turnaround("2026-01-01T10:00:00Z", "2026-01-01T12:05:00Z")).toBe("2h 5m");
  });

  it("formats minutes only when under an hour", () => {
    expect(turnaround("2026-01-01T10:00:00Z", "2026-01-01T10:03:00Z")).toBe("3m");
  });

  it("returns null when claimedAt is null", () => {
    expect(turnaround(null, "2026-01-01T10:03:00Z")).toBeNull();
  });

  it("returns null when either timestamp is unparsable", () => {
    expect(turnaround("not-a-date", "2026-01-01T10:03:00Z")).toBeNull();
  });
});

describe("verdictLabel", () => {
  it.each([
    ["approve", "Approve"],
    ["request-changes", "Request changes"],
    ["comment", "Comment"],
    ["agree", "Agree"],
    ["disagree", "Disagree"],
    ["mixed", "Mixed"],
  ])("labels %s as %s", (input, expected) => {
    expect(verdictLabel(input)).toBe(expected);
  });

  it("returns \"Unknown\" for null", () => {
    expect(verdictLabel(null)).toBe("Unknown");
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-01-04T00:00:00Z");

  it("reports whole days ago for a fixed now", () => {
    expect(relativeTime("2026-01-01T00:00:00Z", now)).toBe("3 days ago");
  });

  it("reports minutes ago for a fixed now", () => {
    expect(relativeTime("2026-01-03T23:55:00Z", now)).toBe("5 minutes ago");
  });

  it("reports \"just now\" when the timestamp equals now", () => {
    expect(relativeTime(now.toISOString(), now)).toBe("just now");
  });

  it("reports a future timestamp relative to a fixed now", () => {
    expect(relativeTime("2026-01-04T02:00:00Z", now)).toBe("in 2 hours");
  });
});
