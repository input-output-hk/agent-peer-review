import { describe, it, expect } from "vitest";
import { FakeGitHubGateway } from "../../test/fakes/fake-github.js";
import { bootstrap } from "./bootstrap.js";

describe("bootstrap", () => {
  it("creates the profile then reports unchanged on re-run", async () => {
    const gh = new FakeGitHubGateway();
    const first = await bootstrap(gh, { repo: "o/r", skillNames: ["security"] });
    expect(first.created).toEqual(["agent", "security"]);
    const second = await bootstrap(gh, { repo: "o/r", skillNames: ["security"] });
    expect(second.created).toEqual([]);
    expect(second.unchanged).toEqual(["agent", "security"]);
  });
});
