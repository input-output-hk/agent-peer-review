import { describe, it, expect } from "vitest";
import { FakeGitHubGateway } from "../test/fakes/fake-github.js";
import { gatherRepoContext } from "./repo-context.js";
describe("gatherRepoContext", () => {
  it("collects exact files + shallow .claude md, skips missing, respects order", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedFile("o/r", "sha", "CLAUDE.md", "root claude");
    gh.seedFile("o/r", "sha", ".claude/CLAUDE.md", "dot claude");
    gh.seedDir("o/r", "sha", ".claude", [".claude/CLAUDE.md", ".claude/notes.md", ".claude/x.txt"]);
    gh.seedFile("o/r", "sha", ".claude/notes.md", "notes");
    const ctx = await gatherRepoContext(gh, "o/r", "sha");
    const paths = ctx.map((c) => c.path);
    expect(paths).toContain("CLAUDE.md");
    expect(paths).toContain(".claude/notes.md");
    expect(paths).not.toContain(".claude/x.txt"); // non-md excluded
    expect(ctx.find((c) => c.path === "AGENT.md")).toBeUndefined(); // missing skipped
  });
  it("returns [] when nothing exists (best-effort, no throw)", async () => {
    expect(await gatherRepoContext(new FakeGitHubGateway(), "o/r", "sha")).toEqual([]);
  });
});
