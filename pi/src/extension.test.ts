import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serializeMarker } from "@input-output-hk/agent-review";
import { registerTools } from "./extension.js";

function fakePi() {
  const tools: any[] = [];
  return { tools, registerTool: (def: any) => tools.push(def) };
}

// claimReview reads a "review" skill file off disk; give it an isolated temp dir
// rather than depending on this repo's real bundled skills/ contents.
function skillsDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "pi-ext-sk-"));
  writeFileSync(path.join(d, "review.md"), "# default review");
  return d;
}

describe("pi extension", () => {
  it("registers the six review tools", () => {
    const pi = fakePi();
    registerTools(pi as any, { gh: () => ({}) as any, config: () => ({ githubLogin: "me", skillsDir: null, runChecks: false }) as any });
    expect(pi.tools.map((t) => t.name).sort()).toEqual(
      ["labels_bootstrap", "review_claim", "review_complete", "review_create", "review_enrich", "review_list"]);
  });
  it("review_list wraps the core result in Pi content shape", async () => {
    const pi = fakePi();
    const gh = { getAuthenticatedLogin: async () => "me", listReviewRequests: async () => [], listComments: async () => [] } as any;
    registerTools(pi as any, { gh: () => gh, config: () => ({ githubLogin: null, skillsDir: null, runChecks: false }) as any });
    const list = pi.tools.find((t) => t.name === "review_list");
    const res = await list.execute("id1", { repo: "o/r" }, undefined, undefined, undefined);
    expect(res.content[0].type).toBe("text");
    expect(JSON.parse(res.content[0].text)).toEqual([]);
  });
  it("review_claim wires params through claimReview and returns the Pi content shape", async () => {
    const pi = fakePi();
    const dir = skillsDir();
    // An existing marker authored by "me" so claimReview resumes rather than posting a new one
    // (createComment is deliberately not stubbed on this fake gateway).
    const marker = serializeMarker({ v: 1, reviewer: "me", machine: "m1", sha: "feed1234", claimedAt: "t0" });
    const gh = {
      getAuthenticatedLogin: async () => "me",
      listReviewRequests: async () => [],
      listComments: async () => [{ id: 1, author: "me", body: marker }],
      getPullRequest: async () => ({
        number: 7, title: "t", author: "a", headSha: "feed1234", baseSha: "base1",
        url: "https://example.com/o/r/pull/7", state: "open" as const, labels: ["agent"],
      }),
      listPullFiles: async () => [],
      getFileContent: async () => null,
      listDir: async () => [],
    } as any;
    registerTools(pi as any, { gh: () => gh, config: () => ({ githubLogin: null, skillsDir: dir, runChecks: false }) as any });
    const claim = pi.tools.find((t) => t.name === "review_claim");
    const res = await claim.execute("id2", { repo: "o/r", pr: 7 }, undefined, undefined, undefined);
    expect(res.content[0].type).toBe("text");
    const task = JSON.parse(res.content[0].text);
    expect(task.headSha).toBe("feed1234");
    expect(task.reviewer).toBe("me");
    expect(task.role).toBe("anchor");
  });
});
