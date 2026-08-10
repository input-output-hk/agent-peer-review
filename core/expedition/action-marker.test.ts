import { describe, it, expect } from "vitest";
import { buildActionMarker, findActionMarkers, type ActionMarker } from "./action-marker.js";
import type { IssueComment } from "../model.js";

const marker = (over: Partial<ActionMarker> = {}): ActionMarker =>
  ({ v: 1, kind: "expedite-proposal", headSha: "abc1234", decision: "propose", at: "2026-08-07T10:00:00Z", ...over });

const comment = (body: string, id = 1, author = "agent-bot"): IssueComment => ({ id, body, author });

// The bare opening delimiter with no payload and no close, as an attacker would smuggle it in.
const OPEN_TOKEN = "<!-- agent-review:action ";

describe("action markers", () => {
  it("round-trips every field", () => {
    const m = marker({ kind: "dep-upgrade-proposal", decision: "auto" });
    const found = findActionMarkers([comment(`some prose\n\n${buildActionMarker(m)}`)]);
    expect(found).toHaveLength(1);
    expect(found[0].marker).toEqual(m);
  });

  it("returns the comment alongside its marker, so a caller can delete it", () => {
    const c = comment(buildActionMarker(marker()), 42);
    expect(findActionMarkers([c])[0].comment).toBe(c);
  });

  it("preserves input order across comments and skips those with no marker", () => {
    const found = findActionMarkers([
      comment("just a comment", 1),
      comment(buildActionMarker(marker({ headSha: "aaa" })), 2),
      comment("another plain comment", 3),
      comment(buildActionMarker(marker({ headSha: "bbb" })), 4),
    ]);
    expect(found.map((f) => f.comment.id)).toEqual([2, 4]);
    expect(found.map((f) => f.marker.headSha)).toEqual(["aaa", "bbb"]);
  });

  it("is empty for no comments", () => {
    expect(findActionMarkers([])).toEqual([]);
  });

  describe("garbage tolerance", () => {
    it.each([
      ["not JSON at all", "<!-- agent-review:action not json -->"],
      ["an unopened marker", "agent-review:action {\"v\":1} -->"],
      ["an unterminated marker", '<!-- agent-review:action {"v":1,"kind":"expedite-proposal"}'],
      ["a JSON array", "<!-- agent-review:action [1,2,3] -->"],
      ["a JSON string", '<!-- agent-review:action "nope" -->'],
      ["null", "<!-- agent-review:action null -->"],
      ["a wrong version", '<!-- agent-review:action {"v":2,"kind":"expedite-proposal","headSha":"a","decision":"propose","at":"t"} -->'],
      ["an unknown kind", '<!-- agent-review:action {"v":1,"kind":"launch-missiles","headSha":"a","decision":"propose","at":"t"} -->'],
      ["a missing headSha", '<!-- agent-review:action {"v":1,"kind":"expedite-proposal","decision":"propose","at":"t"} -->'],
      ["an empty headSha", '<!-- agent-review:action {"v":1,"kind":"expedite-proposal","headSha":"","decision":"propose","at":"t"} -->'],
      ["a bad decision", '<!-- agent-review:action {"v":1,"kind":"expedite-proposal","headSha":"a","decision":"yolo","at":"t"} -->'],
      ["a non-string at", '<!-- agent-review:action {"v":1,"kind":"expedite-proposal","headSha":"a","decision":"propose","at":7} -->'],
      ["the claim marker instead", '<!-- agent-review:claim {"v":1,"reviewer":"me"} -->'],
    ])("skips %s", (_label, body) => {
      expect(findActionMarkers([comment(body)])).toEqual([]);
    });

    it("keeps reading the other comments when one is garbage", () => {
      const found = findActionMarkers([
        comment("<!-- agent-review:action {oops} -->", 1),
        comment(buildActionMarker(marker({ headSha: "good" })), 2),
      ]);
      expect(found).toHaveLength(1);
      expect(found[0].marker.headSha).toBe("good");
    });
  });

  describe("spoofing", () => {
    it("the last parseable marker wins, so quoted prose cannot outrank the real one appended last", () => {
      const spoofed = `A file named ${buildActionMarker(marker({ headSha: "attacker" }))} appeared in the diff.`;
      const body = `${spoofed}\n${buildActionMarker(marker({ headSha: "genuine" }))}`;
      expect(findActionMarkers([comment(body)])[0].marker.headSha).toBe("genuine");
    });

    it("an unparseable trailing look-alike does not hide the genuine marker before it", () => {
      const body = `${buildActionMarker(marker({ headSha: "genuine" }))}\n<!-- agent-review:action {garbage} -->`;
      expect(findActionMarkers([comment(body)])[0].marker.headSha).toBe("genuine");
    });

    // Regression: a scanner that resumed past the CLOSE it found on a FAILED parse would consume
    // the genuine marker's own close delimiter and never see the marker itself. Untrusted text
    // reaches a proposal body through gate reasons, so a bare open token is an attacker's move.
    it("a bare unterminated open token BEFORE the genuine marker does not hide it", () => {
      const body = `a file named src/x${OPEN_TOKEN}y.ts appeared\n${buildActionMarker(marker({ headSha: "genuine" }))}`;
      const found = findActionMarkers([comment(body)]);
      expect(found).toHaveLength(1);
      expect(found[0].marker.headSha).toBe("genuine");
    });

    it("a forged complete marker followed by a bare open token still loses to the genuine one", () => {
      const forged = buildActionMarker(marker({ headSha: "attacker" }));
      const body = `${forged}\nand then ${OPEN_TOKEN}dangling\n${buildActionMarker(marker({ headSha: "genuine" }))}`;
      expect(findActionMarkers([comment(body)])[0].marker.headSha).toBe("genuine");
    });

    it("survives many bare open tokens before the genuine marker", () => {
      const noise = `${OPEN_TOKEN}x `.repeat(500);
      const body = `${noise}${buildActionMarker(marker({ headSha: "genuine" }))}`;
      expect(findActionMarkers([comment(body)])[0].marker.headSha).toBe("genuine");
    });

    it("ignores a marker whose payload is implausibly long rather than scanning past it", () => {
      const bloated = `<!-- agent-review:action {"v":1,"pad":"${"x".repeat(2000)}"} -->`;
      const body = `${bloated}\n${buildActionMarker(marker({ headSha: "genuine" }))}`;
      expect(findActionMarkers([comment(body)])[0].marker.headSha).toBe("genuine");
    });

    it("yields at most one marker per comment", () => {
      const body = `${buildActionMarker(marker({ headSha: "a" }))}${buildActionMarker(marker({ headSha: "b" }))}`;
      expect(findActionMarkers([comment(body)])).toHaveLength(1);
    });
  });

  it("builds a hidden HTML comment carrying flat JSON", () => {
    const built = buildActionMarker(marker());
    expect(built.startsWith("<!-- agent-review:action ")).toBe(true);
    expect(built.endsWith(" -->")).toBe(true);
    expect(built).toContain('"headSha":"abc1234"');
  });
});
