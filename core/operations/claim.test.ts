import { describe, it, expect } from "vitest";
import { FakeGitHubGateway } from "../../test/fakes/fake-github.js";
import { claimReview } from "./claim.js";
import { serializeMarker, parseMarkers } from "../claim-marker.js";
import { PRIMARY_MARKER } from "../claim-marker.js";
import { serializeReviewRecord } from "../review-record.js";
import type { ReviewFinding } from "../model.js";
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
const cfg = (dir: string) => ({ githubLogin: null, skillsDir: dir, captureMetadata: false, reviewers: [], knownAgentLogins: [] });
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

  it("returns bounded normalized review history and convergence mode without old review bodies", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 22, title: "t", author: "a", headSha: "sha0003", baseSha: "b", url: "u", state: "open", labels: ["ai-review"] });
    const root: ReviewFinding = {
      id: "parser-family", title: "Unbounded parser surface", severity: "high", confidence: "confirmed",
      scope: "introduced", status: "open", blocking: true, path: "src/policy.ts", line: 42,
      evidence: "A finite reproducer exercises the same abstraction failure.",
      remediation: "Narrow the accepted syntax or use an established parser.",
    };
    gh.login = "peer";
    for (const [sha, mode] of [["sha0001", "initial"], ["sha0002", "rereview"]] as const) {
      await gh.submitReview("o/r", 22, {
        commitId: sha,
        event: "REQUEST_CHANGES",
        body: `private historical prose must not be returned\n\n${serializeReviewRecord({
          v: 1, reviewedSha: sha, mode, role: "primary", verdict: "request-changes", findings: [root],
        })}\n\n${PRIMARY_MARKER}`,
      });
    }
    gh.login = "me";

    const task = await claimReview(deps(gh, skillsDir()), { repo: "o/r", pr: 22 });

    expect(task.reviewContractVersion).toBe(1);
    expect(task.reviewHistory).toMatchObject({
      mode: "convergence", changesRequestedCycles: 2, reviewedShas: ["sha0001", "sha0002"],
      findings: [{ id: "parser-family", status: "open" }], lastVerdict: "request-changes", truncated: false,
    });
    expect(JSON.stringify(task.reviewHistory)).not.toContain("private historical prose");
  });

  it("resumes the pinned SHA while it is still the head", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 6, title: "t", author: "a", headSha: "cafe1234", baseSha: "b", url: "u", state: "open", labels: ["ai-review"] });
    await gh.createComment("o/r", 6, serializeMarker({ v: 1, reviewer: "me", machine: "other", sha: "cafe1234", claimedAt: "t0" }));
    const task = await claimReview(deps(gh, skillsDir()), { repo: "o/r", pr: 6 });
    expect(task.headSha).toBe("cafe1234");
    const comments = await gh.listComments("o/r", 6);
    expect(comments).toHaveLength(1);
    expect(parseMarkers(comments)[0].marker.claimedAt).toBe("t0"); // untouched, not reposted
  });

  it("never deletes a foreign comment whose marker text claims this reviewer", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 20, title: "t", author: "a", headSha: "sha-new0", baseSha: "b", url: "u", state: "open", labels: ["ai-review"] });
    gh.login = "maintainer";
    const foreign = await gh.createComment("o/r", 20, serializeMarker({
      v: 1, reviewer: "me", machine: "forged", sha: "sha-old0", claimedAt: "t0",
    }));
    gh.login = "me";

    await claimReview(deps(gh, skillsDir()), { repo: "o/r", pr: 20 });

    const comments = await gh.listComments("o/r", 20);
    expect(comments).toContainEqual(foreign);
    expect(comments.some((comment) => comment.author === "me")).toBe(true);
  });

  // Issue #52, livelock 2. A claim marker used to be a permanent SHA pin: this branch resumed
  // whatever commit the marker named and nothing ever moved it, so an agent whose run stalled
  // re-claimed a dead commit on every tick, reviewed code that no longer existed, and the drift that
  // produced then read to the watch path as an author push, manufacturing another round.
  describe("re-pinning a stale claim", () => {
    it("re-pins to the current head, leaving exactly one marker", async () => {
      const gh = new FakeGitHubGateway();
      gh.seedPr({ number: 6, title: "t", author: "a", headSha: "sha0004", baseSha: "b", url: "u", state: "open", labels: ["ai-review"] });
      await gh.createComment("o/r", 6, serializeMarker({ v: 1, reviewer: "me", machine: "mbp-01", sha: "sha0001", claimedAt: "t0" }));

      const task = await claimReview(deps(gh, skillsDir(), "mbp-01", "t5"), { repo: "o/r", pr: 6 });
      expect(task.headSha).toBe("sha0004"); // the CURRENT head, not the dead commit
      const comments = await gh.listComments("o/r", 6);
      expect(comments).toHaveLength(1); // the stale marker is gone, not merely outnumbered
      // claimedAt is carried over: the re-pin moves the commit, not the agent's place in the queue.
      expect(parseMarkers(comments)[0].marker).toEqual({ v: 1, reviewer: "me", machine: "mbp-01", sha: "sha0004", claimedAt: "t0" });
      expect(comments[0].body).toContain("pinned to sha0004"); // and the human line says so too
      expect(task.role).toBe("anchor");
      expect(task.repoContext).toEqual([]); // context is gathered at the new pin, not the old one
    });

    it("carries v2 metadata across the re-pin", async () => {
      const gh = new FakeGitHubGateway();
      gh.seedPr({ number: 9, title: "t", author: "a", headSha: "sha0002", baseSha: "b", url: "u", state: "open", labels: ["ai-review"] });
      const original = { v: 2, reviewer: "me", machine: "mbp-01", sha: "sha0001", claimedAt: "t0", model: "claude-opus-4-8", agent: "claude-code", toolVersion: "1.0.0" } as const;
      await gh.createComment("o/r", 9, serializeMarker(original));

      const task = await claimReview(deps(gh, skillsDir()), { repo: "o/r", pr: 9 });
      expect(task.headSha).toBe("sha0002");
      expect(parseMarkers(await gh.listComments("o/r", 9))[0].marker).toEqual({ ...original, sha: "sha0002" });
    });

    it("keeps the anchor the anchor: a re-pin does not reorder the panel", async () => {
      const dir = skillsDir();
      const gh = new FakeGitHubGateway();
      gh.seedPr({ number: 5, title: "t", author: "a", headSha: "sha0001", baseSha: "b", url: "u", state: "open", labels: ["ai-review"] });
      gh.login = "alice";
      expect((await claimReview({ gh, config: cfg(dir), machine: "m1", now: "2026-07-30T00:00:00Z" }, { repo: "o/r", pr: 5 })).role).toBe("anchor");
      gh.login = "bob";
      expect((await claimReview({ gh, config: cfg(dir), machine: "m2", now: "2026-07-30T00:01:00Z" }, { repo: "o/r", pr: 5 })).role).toBe("enricher");

      // The author pushes. Both agents re-claim, later than the other's original claim, and the roles
      // must not swap: an anchor that became an enricher would leave the round with no primary.
      gh.prs.get("o/r#5")!.headSha = "sha0002";
      gh.login = "alice";
      const alice = await claimReview({ gh, config: cfg(dir), machine: "m1", now: "2026-07-30T01:00:00Z" }, { repo: "o/r", pr: 5 });
      expect(alice.role).toBe("anchor");
      expect(alice.headSha).toBe("sha0002");
      gh.login = "bob";
      const bob = await claimReview({ gh, config: cfg(dir), machine: "m2", now: "2026-07-30T01:01:00Z" }, { repo: "o/r", pr: 5 });
      expect(bob.role).toBe("enricher");
      expect(bob.headSha).toBe("sha0002");
      expect(await gh.listComments("o/r", 5)).toHaveLength(2); // one marker each, still
    });

    it("collapses a duplicate claim of its own onto the current head", async () => {
      // A claim race can leave two markers by the same reviewer. Re-pinning only the earliest would
      // put the stale one back at the front of the queue on the next tick, and re-pin every tick.
      const gh = new FakeGitHubGateway();
      gh.seedPr({ number: 7, title: "t", author: "a", headSha: "sha0003", baseSha: "b", url: "u", state: "open", labels: ["ai-review"] });
      await gh.createComment("o/r", 7, serializeMarker({ v: 1, reviewer: "me", machine: "mbp-01", sha: "sha0001", claimedAt: "t0" }));
      await gh.createComment("o/r", 7, serializeMarker({ v: 1, reviewer: "me", machine: "mbp-02", sha: "sha0002", claimedAt: "t1" }));

      const task = await claimReview(deps(gh, skillsDir()), { repo: "o/r", pr: 7 });
      expect(task.headSha).toBe("sha0003");
      const markers = parseMarkers(await gh.listComments("o/r", 7));
      expect(markers).toHaveLength(1);
      expect(markers[0].marker).toMatchObject({ sha: "sha0003", claimedAt: "t0" }); // the earliest claim survives

      // And it is stable: a second tick at the same head resumes without writing anything.
      await claimReview(deps(gh, skillsDir()), { repo: "o/r", pr: 7 });
      expect(await gh.listComments("o/r", 7)).toHaveLength(1);
    });
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
    expect(marker).toEqual({ v: 1, reviewer: "me", sha: "sha00008", claimedAt: "t1" });
    expect((await gh.listComments("o/r", 8))[0].body).not.toContain("mbp-01");
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
