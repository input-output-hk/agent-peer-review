import { describe, it, expect } from "vitest";
import { humanReviewInFlight } from "./human-review.js";
import { serializeMeta } from "../review-meta.js";
import type { Review } from "../model.js";

const AGENT_BODY = `Looks fine.\n\n${serializeMeta({ v: 1, role: "primary", verdict: "approve" })}`;

const review = (author: string, body = "looks fine"): Review =>
  ({ id: 1, author, state: "COMMENTED", body, commitId: "abc1234", submittedAt: "t1" });

const input = (over: Partial<Parameters<typeof humanReviewInFlight>[0]> = {}) => ({
  reviews: [], requestedUsers: [], actingLogin: "agent-bot", ...over,
});

describe("humanReviewInFlight", () => {
  it("is false with no reviews and no requests", () => {
    expect(humanReviewInFlight(input())).toBe(false);
  });

  describe("open review requests", () => {
    it("a requested user who is not a known agent counts as a human in flight", () => {
      expect(humanReviewInFlight(input({ requestedUsers: ["alice"] }))).toBe(true);
    });

    it("a requested known agent does not", () => {
      expect(humanReviewInFlight(input({ requestedUsers: ["peer-bot"], knownAgentLogins: ["peer-bot"] }))).toBe(false);
    });

    it("the acting agent's own open request does not", () => {
      expect(humanReviewInFlight(input({ requestedUsers: ["agent-bot"] }))).toBe(false);
    });
  });

  describe("submitted reviews", () => {
    it("a review by an unknown login with no agent footer counts as a human", () => {
      expect(humanReviewInFlight(input({ reviews: [review("alice")] }))).toBe(true);
    });

    // The footer is self-asserted text in a review body: anyone can paste it. Honoring it would let
    // a human switch off the rail meant to stop the agent racing them, so it carries no weight and
    // only the caller's agent list does.
    it("a review by an unknown login is STILL a human even when its body carries the agent meta footer", () => {
      expect(humanReviewInFlight(input({ reviews: [review("some-agent-account", AGENT_BODY)] }))).toBe(true);
    });

    it("the footer cannot promote an unknown login, but a listed login needs no footer", () => {
      const reviews = [review("peer-bot", "no footer at all")];
      expect(humanReviewInFlight(input({ reviews, knownAgentLogins: ["peer-bot"] }))).toBe(false);
      expect(humanReviewInFlight(input({ reviews }))).toBe(true); // same review, login not listed
    });

    it("the acting agent's own review does not count", () => {
      expect(humanReviewInFlight(input({ reviews: [review("agent-bot")] }))).toBe(false);
    });

    it("a known agent's review does not count, footer or not", () => {
      expect(humanReviewInFlight(input({ reviews: [review("peer-bot")], knownAgentLogins: ["peer-bot"] }))).toBe(false);
    });

    it("one human among several agents is enough", () => {
      const reviews = [review("agent-bot"), review("peer-bot"), review("carol")];
      expect(humanReviewInFlight(input({ reviews, knownAgentLogins: ["peer-bot"] }))).toBe(true);
    });

    it("a garbled footer does not clear a review either", () => {
      const reviews = [review("mystery", "<!-- agent-review:meta {not json} -->")];
      expect(humanReviewInFlight(input({ reviews }))).toBe(true);
    });

    it("a login differing only in case is treated as unknown, which fails toward human", () => {
      expect(humanReviewInFlight(input({ reviews: [review("Agent-Bot")] }))).toBe(true);
    });
  });
});
