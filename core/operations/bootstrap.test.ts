import { describe, it, expect } from "vitest";
import { FakeGitHubGateway } from "../../test/fakes/fake-github.js";
import { bootstrap } from "./bootstrap.js";

describe("bootstrap", () => {
  it("creates the profile then reports unchanged on re-run", async () => {
    const gh = new FakeGitHubGateway();
    const first = await bootstrap(gh, { repo: "o/r", skillNames: ["security"] });
    expect(first.created).toEqual(["ai-review", "security"]);
    const second = await bootstrap(gh, { repo: "o/r", skillNames: ["security"] });
    expect(second.created).toEqual([]);
    expect(second.unchanged).toEqual(["ai-review", "security"]);
  });

  // Issue #67 item 6: ensureLabel lists the repository's labels to decide, so a profile of twelve
  // labels cost twelve list round trips on the first command a new user ever runs.
  it("lists the repository's labels once for the whole profile", async () => {
    const gh = new FakeGitHubGateway();
    await bootstrap(gh, { repo: "o/r" }); // the full twelve-label profile
    expect(gh.listLabelsCalls).toEqual(["o/r"]);
  });

  it("still creates every label from the one snapshot, and updates a drifted one", async () => {
    const gh = new FakeGitHubGateway();
    gh.labels.set("o/r", [{ name: "security", color: "000000", description: "wrong" }]);

    const result = await bootstrap(gh, { repo: "o/r", skillNames: ["security", "testing"] });

    // Nothing lost by reusing one snapshot across the loop: the label created first is still there
    // after the last one, and the drifted label was recognized from the same snapshot.
    expect(result.created).toEqual(["ai-review", "testing"]);
    expect(result.updated).toEqual(["security"]);
    expect((await gh.listLabels("o/r")).map((l) => l.name).sort()).toEqual(["ai-review", "security", "testing"]);
    expect((await gh.listLabels("o/r")).find((l) => l.name === "security")?.description).toBe("Load the security review skill");
  });
});
