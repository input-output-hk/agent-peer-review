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

  it("refuses when another login holds the claim", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 8, title: "t", author: "a", headSha: "x", baseSha: "b", url: "u", state: "open", labels: ["agent"] });
    // NOTE: brief's fixture used sha: "y" (1 char), which fails the pre-existing
    // ClaimMarkerSchema `sha: z.string().min(7)` invariant (core/model.ts) and gets
    // silently dropped by parseMarkers's try/catch (core/claim-marker.ts) — the same
    // class of fixture bug hit in task 12 with sha: "sha3". Using a >=7-char sha here
    // so the marker actually parses and the "already claimed" path is exercised.
    await gh.createComment("o/r", 8, serializeMarker({ v: 1, reviewer: "alice", machine: "a", sha: "yyyyyyy", claimedAt: "t0" }));
    await expect(claimReview(deps(gh, skillsDir()), { repo: "o/r", pr: 8 })).rejects.toThrow(/already claimed/i);
  });
});
