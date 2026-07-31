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
  it("recurses one level into .claude/skills subdirs for SKILL.md", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedDir("o/r", "sha", ".claude/skills", [".claude/skills/foo"]);
    gh.seedDir("o/r", "sha", ".claude/skills/foo", [".claude/skills/foo/SKILL.md"]);
    gh.seedFile("o/r", "sha", ".claude/skills/foo/SKILL.md", "skill body");
    const ctx = await gatherRepoContext(gh, "o/r", "sha");
    const paths = ctx.map((c) => c.path);
    expect(paths).toContain(".claude/skills/foo/SKILL.md");
  });
  it("skips a file with empty content (e.g. a >1MB file GitHub returns as empty)", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedFile("o/r", "sha", "AGENT.md", "");
    gh.seedFile("o/r", "sha", "CLAUDE.md", "hi");
    const ctx = await gatherRepoContext(gh, "o/r", "sha");
    const paths = ctx.map((c) => c.path);
    expect(paths).toContain("CLAUDE.md");
    expect(paths).not.toContain("AGENT.md");
  });
  it("labels every gathered file as untrusted", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedFile("o/r", "sha", "CLAUDE.md", "root claude");
    const ctx = await gatherRepoContext(gh, "o/r", "sha");
    expect(ctx.length).toBeGreaterThan(0);
    expect(ctx.every((c) => c.untrusted === true)).toBe(true);
  });
  it("measures the size cap in UTF-8 bytes, not UTF-16 code units", async () => {
    const gh = new FakeGitHubGateway();
    const multibyte = "€".repeat(30000); // 30000 chars, 90000 UTF-8 bytes (> 64 KiB cap)
    gh.seedFile("o/r", "sha", "AGENT.md", multibyte);
    gh.seedFile("o/r", "sha", "CLAUDE.md", "small");
    const ctx = await gatherRepoContext(gh, "o/r", "sha");
    const paths = ctx.map((c) => c.path);
    expect(paths).not.toContain("AGENT.md"); // byte length exceeds the cap even though char length is under it
    expect(paths).toContain("CLAUDE.md"); // a later small file still fits
  });
  it("stops at the file-count cap", async () => {
    const gh = new FakeGitHubGateway();
    const files = Array.from({ length: 12 }, (_, i) => `.claude/n${i}.md`);
    gh.seedDir("o/r", "sha", ".claude", files);
    for (const f of files) gh.seedFile("o/r", "sha", f, "x");
    const ctx = await gatherRepoContext(gh, "o/r", "sha");
    expect(ctx.length).toBe(10); // FILE_CAP
  });
});
