import { describe, it, expect } from "vitest";
import { FakeGitHubGateway } from "../../test/fakes/fake-github.js";
import { listReviews } from "./list.js";
import { serializeMarker } from "../claim-marker.js";

describe("listReviews", () => {
  it("returns open agent PRs requested from the login, with claim state", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 3, title: "t", author: "a", headSha: "sha3", baseSha: "b", url: "u", state: "open", labels: ["agent", "security", "bug"] });
    gh.seedRequest("o/r", 3, "me");
    await gh.createComment("o/r", 3, serializeMarker({ v: 1, reviewer: "me", machine: "m", sha: "sha3000", claimedAt: "t" }));
    const rows = await listReviews(gh, { repo: "o/r" }); // login auto-detected as "me"
    expect(rows).toHaveLength(1);
    expect(rows[0].skills).toEqual(["security"]); // "bug" ignored
    expect(rows[0].claim?.machine).toBe("m");
  });

  it("uses the earliest marker as the active claim when the same login has more than one", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 4, title: "t", author: "a", headSha: "sha4", baseSha: "b", url: "u", state: "open", labels: ["agent"] });
    gh.seedRequest("o/r", 4, "me");
    // Post the EARLIEST-claimed marker FIRST and the later one SECOND, so the earliest is not the
    // last-posted comment. `.at(-1)` (the old bug) would pick m2; sortMarkers()[0] picks m1.
    await gh.createComment("o/r", 4, serializeMarker({ v: 1, reviewer: "me", machine: "m1", sha: "sha4a00", claimedAt: "2026-07-30T00:00:00Z" }));
    await gh.createComment("o/r", 4, serializeMarker({ v: 1, reviewer: "me", machine: "m2", sha: "sha4b00", claimedAt: "2026-07-30T00:01:00Z" }));
    const rows = await listReviews(gh, { repo: "o/r" });
    expect(rows[0].claim?.machine).toBe("m1"); // earliest claimedAt, even though it was NOT posted last
  });
});
