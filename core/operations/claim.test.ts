import { describe, it, expect } from "vitest";
import { FakeGitHubGateway } from "../../test/fakes/fake-github.js";
import { claimReview } from "./claim.js";
import { serializeMarker } from "../claim-marker.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function skillsDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "sk-"));
  writeFileSync(path.join(d, "review.md"), "# default review");
  writeFileSync(path.join(d, "security.md"), "# security");
  writeFileSync(path.join(d, "second-opinion.md"), "# second opinion");
  return d;
}
const cfg = (dir: string) => ({ githubLogin: null, skillsDir: dir, runChecks: false });
const deps = (gh: FakeGitHubGateway, dir: string, machine = "mbp-01", now = "t1") => ({ gh, config: cfg(dir), machine, now });

describe("claimReview", () => {
  it("pins the head SHA, posts a marker, returns composed skills", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 5, title: "t", author: "a", headSha: "deadbeef", baseSha: "b", url: "u", state: "open", labels: ["agent", "security"] });
    const task = await claimReview(deps(gh, skillsDir()), { repo: "o/r", pr: 5 });
    expect(task.headSha).toBe("deadbeef");
    expect(task.reviewer).toBe("me"); // auto-detected
    expect(task.instructions.skills.map((s) => s.name)).toEqual(["security"]);
    expect((await gh.listComments("o/r", 5)).length).toBe(1); // marker posted
  });

  it("resumes when the same login already holds the claim", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 6, title: "t", author: "a", headSha: "cafe1234", baseSha: "b", url: "u", state: "open", labels: ["agent"] });
    await gh.createComment("o/r", 6, serializeMarker({ v: 1, reviewer: "me", machine: "other", sha: "old1234", claimedAt: "t0" }));
    const task = await claimReview(deps(gh, skillsDir()), { repo: "o/r", pr: 6 });
    expect(task.headSha).toBe("old1234"); // resumes the pinned SHA
  });

  it("lets a second login also claim; earliest is anchor, next is enricher", async () => {
    const dir = skillsDir();
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 5, title: "t", author: "a", headSha: "deadbeef", baseSha: "b", url: "u", state: "open", labels: ["agent", "security"] });
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
    gh.seedPr({ number: 6, title: "t", author: "a", headSha: "cafe1234", baseSha: "b", url: "u", state: "open", labels: ["agent"] });
    gh.login = "alice";
    await claimReview({ gh, config: cfg(dir), machine: "m1", now: "2026-07-30T00:00:00Z" }, { repo: "o/r", pr: 6 });
    const again = await claimReview({ gh, config: cfg(dir), machine: "m1", now: "2026-07-30T00:05:00Z" }, { repo: "o/r", pr: 6 });
    expect(again.role).toBe("anchor");
    expect(again.headSha).toBe("cafe1234");
  });
});
