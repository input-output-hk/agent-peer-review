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
});
