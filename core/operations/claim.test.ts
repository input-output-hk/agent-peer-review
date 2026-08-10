import { describe, it, expect } from "vitest";
import { FakeGitHubGateway } from "../../test/fakes/fake-github.js";
import { claimReview } from "./claim.js";
import { serializeMarker, parseMarkers } from "../claim-marker.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function skillsDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "sk-"));
  writeFileSync(path.join(d, "review.md"), "# default review");
  writeFileSync(path.join(d, "security.md"), "# security");
  writeFileSync(path.join(d, "second-opinion.md"), "# second opinion");
  mkdirSync(path.join(d, "lang"));
  writeFileSync(path.join(d, "lang", "typescript.md"), "# typescript");
  writeFileSync(path.join(d, "lang", "solidity.md"), "# solidity");
  return d;
}
const cfg = (dir: string) => ({ githubLogin: null, skillsDir: dir, runChecks: false, captureMetadata: false, reviewers: [], knownAgentLogins: [] });
const deps = (gh: FakeGitHubGateway, dir: string, machine = "mbp-01", now = "t1") => ({ gh, config: cfg(dir), machine, now });

describe("claimReview", () => {
  it("pins the head SHA, posts a marker, returns composed skills", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 5, title: "t", author: "a", headSha: "deadbeef", baseSha: "b", url: "u", state: "open", labels: ["ai-review", "security"] });
    gh.seedPullFiles("o/r", 5, ["a.ts", "b.sol"]);
    gh.seedFile("o/r", "deadbeef", "CLAUDE.md", "x");
    const task = await claimReview(deps(gh, skillsDir()), { repo: "o/r", pr: 5 });
    expect(task.headSha).toBe("deadbeef");
    expect(task.reviewer).toBe("me"); // auto-detected
    expect(task.instructions.skills.map((s) => s.name)).toEqual(["security"]);
    expect((await gh.listComments("o/r", 5)).length).toBe(1); // marker posted
    expect(task.languages).toEqual(["solidity", "typescript"]); // detected from changed files
    expect(task.instructions.languages.map((l) => l.name)).toEqual(["solidity", "typescript"]);
    expect(task.repoContext.map((f) => f.path)).toContain("CLAUDE.md"); // gathered at pinned SHA
    expect(task.repoContext.every((f) => f.untrusted === true)).toBe(true); // repo files flagged untrusted
    expect(task.contentPolicy).toMatch(/untrusted/i); // standing injection-resistance policy served
  });

  it("resumes when the same login already holds the claim", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 6, title: "t", author: "a", headSha: "cafe1234", baseSha: "b", url: "u", state: "open", labels: ["ai-review"] });
    await gh.createComment("o/r", 6, serializeMarker({ v: 1, reviewer: "me", machine: "other", sha: "old1234", claimedAt: "t0" }));
    const task = await claimReview(deps(gh, skillsDir()), { repo: "o/r", pr: 6 });
    expect(task.headSha).toBe("old1234"); // resumes the pinned SHA
  });

  it("lets a second login also claim; earliest is anchor, next is enricher", async () => {
    const dir = skillsDir();
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 5, title: "t", author: "a", headSha: "deadbeef", baseSha: "b", url: "u", state: "open", labels: ["ai-review", "security"] });
    gh.login = "alice";
    const a = await claimReview({ gh, config: cfg(dir), machine: "m1", now: "2026-07-30T00:00:00Z" }, { repo: "o/r", pr: 5 });
    expect(a.role).toBe("anchor");
    gh.login = "bob";
    const b = await claimReview({ gh, config: cfg(dir), machine: "m2", now: "2026-07-30T00:01:00Z" }, { repo: "o/r", pr: 5 });
    expect(b.role).toBe("enricher");
    expect(b.instructions.skills.map((s) => s.name)).toContain("second-opinion"); // auto-served to enrichers
    expect(a.instructions.skills.map((s) => s.name)).not.toContain("second-opinion");
  });

  it("resumes the same login's claim as anchor on the pinned SHA", async () => {
    const dir = skillsDir();
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 6, title: "t", author: "a", headSha: "cafe1234", baseSha: "b", url: "u", state: "open", labels: ["ai-review"] });
    gh.login = "alice";
    await claimReview({ gh, config: cfg(dir), machine: "m1", now: "2026-07-30T00:00:00Z" }, { repo: "o/r", pr: 6 });
    const again = await claimReview({ gh, config: cfg(dir), machine: "m1", now: "2026-07-30T00:05:00Z" }, { repo: "o/r", pr: 6 });
    expect(again.role).toBe("anchor");
    expect(again.headSha).toBe("cafe1234");
  });

  it("filters a manually-applied second-opinion label so only the enricher auto-inject serves it, exactly once", async () => {
    const dir = skillsDir();
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 7, title: "t", author: "a", headSha: "feed1234", baseSha: "b", url: "u", state: "open", labels: ["ai-review", "second-opinion"] });
    gh.login = "alice";
    const a = await claimReview({ gh, config: cfg(dir), machine: "m1", now: "2026-07-30T00:00:00Z" }, { repo: "o/r", pr: 7 });
    expect(a.role).toBe("anchor");
    expect(a.skills).not.toContain("second-opinion");
    expect(a.instructions.skills.map((s) => s.name)).not.toContain("second-opinion");
    gh.login = "bob";
    const b = await claimReview({ gh, config: cfg(dir), machine: "m2", now: "2026-07-30T00:01:00Z" }, { repo: "o/r", pr: 7 });
    expect(b.role).toBe("enricher");
    expect(b.instructions.skills.filter((s) => s.name === "second-opinion")).toHaveLength(1);
  });

  it("posts a v1 marker with no metadata when captureMetadata is off (default)", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 8, title: "t", author: "a", headSha: "sha00008", baseSha: "b", url: "u", state: "open", labels: ["ai-review"] });
    await claimReview(deps(gh, skillsDir()), { repo: "o/r", pr: 8 });
    const marker = parseMarkers(await gh.listComments("o/r", 8))[0].marker;
    expect(marker).toEqual({ v: 1, reviewer: "me", machine: "mbp-01", sha: "sha00008", claimedAt: "t1" });
  });

  it("posts a v2 marker carrying model/agent/toolVersion when captureMetadata is on", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 9, title: "t", author: "a", headSha: "sha00009", baseSha: "b", url: "u", state: "open", labels: ["ai-review"] });
    const config = { ...cfg(skillsDir()), captureMetadata: true, model: "claude-opus-4-8", agent: "claude-code", toolVersion: "1.0.0" };
    await claimReview({ gh, config, machine: "mbp-01", now: "t1" }, { repo: "o/r", pr: 9 });
    const marker = parseMarkers(await gh.listComments("o/r", 9))[0].marker;
    expect(marker).toEqual({
      v: 2, reviewer: "me", machine: "mbp-01", sha: "sha00009", claimedAt: "t1",
      model: "claude-opus-4-8", agent: "claude-code", toolVersion: "1.0.0",
    });
  });
});
