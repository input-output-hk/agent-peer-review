import { describe, it, expect } from "vitest";
import { humanReviewStatus } from "./human-review.js";
import { serializeMeta } from "../review-meta.js";
import type { Review } from "../model.js";

const AGENT_BODY = `Looks fine.\n\n${serializeMeta({ v: 1, role: "primary", verdict: "approve" })}`;

const HEAD = "abc1234";

let seq = 0;
// Ids and timestamps ascend together, so a test can hand reviews over in any order and "which verdict
// is the standing one" is still unambiguous.
const at = (author: string, state: string, body = "looks fine", commitId = HEAD): Review => {
  const n = ++seq;
  return { id: n, author, state, body, commitId, submittedAt: `2026-08-07T10:00:${String(n).padStart(2, "0")}Z` };
};
const review = (author: string, body = "looks fine"): Review => at(author, "COMMENTED", body);

const input = (over: Partial<Parameters<typeof humanReviewStatus>[0]> = {}) => ({
  reviews: [], requestedUsers: [], actingLogin: "agent-bot", ...over,
});

const status = (over: Partial<Parameters<typeof humanReviewStatus>[0]> = {}) => humanReviewStatus(input(over));

/** Rail 7 blocks on either half, so "does a human stand in the way" is their disjunction. */
const blocks = (over: Partial<Parameters<typeof humanReviewStatus>[0]> = {}): boolean => {
  const s = status(over);
  return s.pendingRequest || s.changesRequested;
};

describe("humanReviewStatus", () => {
  it("is clear with no reviews and no requests", () => {
    expect(status()).toEqual({ pendingRequest: false, changesRequested: false });
  });

  describe("open review requests: the only real in flight", () => {
    it("a requested user who is not a known agent is a pending human review", () => {
      expect(status({ requestedUsers: ["alice"] })).toEqual({ pendingRequest: true, changesRequested: false });
    });

    it("a requested known agent is not", () => {
      expect(blocks({ requestedUsers: ["peer-bot"], knownAgentLogins: ["peer-bot"] })).toBe(false);
    });

    it("the acting agent's own open request is not", () => {
      expect(blocks({ requestedUsers: ["agent-bot"] })).toBe(false);
    });

    it("a submitted review does not create a pending request: the two are read separately", () => {
      // GitHub clears the request when the reviewer answers, and nothing else here invents one.
      expect(status({ reviews: [at("alice", "APPROVED")] }).pendingRequest).toBe(false);
    });
  });

  // Issue #57. The rail used to be true as soon as any human had left any review, in any state, and a
  // GitHub review is permanent history: on a repository that requires an approving review, the review
  // that satisfied rail 5 was the same event that failed this one, forever.
  describe("a human's standing verdict", () => {
    it("CHANGES_REQUESTED blocks, and reports itself as a verdict rather than as a race", () => {
      expect(status({ reviews: [at("alice", "CHANGES_REQUESTED")] }))
        .toEqual({ pendingRequest: false, changesRequested: true });
    });

    it("APPROVED does NOT block: it is the outcome the workflow wants", () => {
      expect(status({ reviews: [at("alice", "APPROVED")] }))
        .toEqual({ pendingRequest: false, changesRequested: false });
    });

    it("a CHANGES_REQUESTED that the same human later replaced with an APPROVED stops blocking", () => {
      const refused = at("alice", "CHANGES_REQUESTED");
      const approved = at("alice", "APPROVED"); // later
      expect(blocks({ reviews: [refused, approved] })).toBe(false);
      expect(blocks({ reviews: [approved, refused] })).toBe(false); // same answer, array order reversed
    });

    it("an APPROVED that the same human later replaced with a CHANGES_REQUESTED blocks again", () => {
      const approved = at("alice", "APPROVED");
      const refused = at("alice", "CHANGES_REQUESTED"); // later
      expect(status({ reviews: [approved, refused] }).changesRequested).toBe(true);
    });

    it("a later COMMENTED review does not withdraw a standing CHANGES_REQUESTED", () => {
      expect(status({ reviews: [at("alice", "CHANGES_REQUESTED"), at("alice", "COMMENTED")] }).changesRequested).toBe(true);
    });

    // The asymmetry with rail 5's approvals is deliberate: an approval of an old commit says nothing
    // about the code that would merge, so it must not COUNT; a refusal of an old commit is a person's
    // outstanding objection until they replace it, so it must still BLOCK.
    it("blocks whatever commit the refusal was left on", () => {
      expect(status({ reviews: [at("alice", "CHANGES_REQUESTED", "no", "an-older-sha")] }).changesRequested).toBe(true);
    });

    it("a DISMISSED review blocks nothing: the verdict it carried has been retired", () => {
      expect(blocks({ reviews: [at("alice", "CHANGES_REQUESTED"), at("alice", "DISMISSED")] })).toBe(false);
      expect(blocks({ reviews: [at("alice", "DISMISSED")] })).toBe(false);
    });

    it("one human's refusal is enough, among any number of approvals", () => {
      const reviews = [at("alice", "APPROVED"), at("peer-bot", "APPROVED"), at("carol", "CHANGES_REQUESTED")];
      expect(status({ reviews, knownAgentLogins: ["peer-bot"] })).toEqual({ pendingRequest: false, changesRequested: true });
    });

    it("the acting agent's own CHANGES_REQUESTED is not a human's", () => {
      expect(blocks({ reviews: [at("agent-bot", "CHANGES_REQUESTED")] })).toBe(false);
    });

    it("a known agent's CHANGES_REQUESTED is not a human's either", () => {
      expect(blocks({ reviews: [at("peer-bot", "CHANGES_REQUESTED")], knownAgentLogins: ["peer-bot"] })).toBe(false);
    });
  });

  describe("comment-only reviews", () => {
    // Chosen over "ignore comments older than the head": that variant is the same permanent-history
    // bug in miniature, since a pull request whose head never moves again would be held forever by one
    // drive-by note. A comment states no position, which is already this package's rule everywhere
    // else, and a human who wants a pull request stopped has the CHANGES_REQUESTED button.
    it("never block, whoever left them and whenever", () => {
      expect(blocks({ reviews: [review("alice")] })).toBe(false);
      expect(blocks({ reviews: [at("alice", "COMMENTED", "note", "an-older-sha")] })).toBe(false);
      expect(blocks({ reviews: [review("alice"), review("carol")] })).toBe(false);
    });

    it("do not stop a standing refusal by someone else from blocking", () => {
      expect(status({ reviews: [review("alice"), at("carol", "CHANGES_REQUESTED")] }).changesRequested).toBe(true);
    });
  });

  describe("who counts as a human", () => {
    // The footer is self-asserted text in a review body: anyone can paste it. Honoring it would let a
    // human switch off the rail meant to stop the agent racing them, so it carries no weight and only
    // the caller's agent list does.
    it("a refusal by an unknown login is STILL a human's even when its body carries the agent meta footer", () => {
      expect(status({ reviews: [at("some-agent-account", "CHANGES_REQUESTED", AGENT_BODY)] }).changesRequested).toBe(true);
    });

    it("the footer cannot promote an unknown login, but a listed login needs no footer", () => {
      const reviews = [at("peer-bot", "CHANGES_REQUESTED", "no footer at all")];
      expect(blocks({ reviews, knownAgentLogins: ["peer-bot"] })).toBe(false);
      expect(blocks({ reviews })).toBe(true); // the same review, login not listed
    });

    it("a garbled footer does not clear a refusal either", () => {
      expect(blocks({ reviews: [at("mystery", "CHANGES_REQUESTED", "<!-- agent-review:meta {not json} -->")] })).toBe(true);
    });

    it("a login differing only in case is treated as unknown, which fails toward human", () => {
      expect(blocks({ reviews: [at("Agent-Bot", "CHANGES_REQUESTED")] })).toBe(true);
      expect(blocks({ requestedUsers: ["Agent-Bot"] })).toBe(true);
    });
  });
});
