import { describe, expect, it } from "vitest";
import { FakeGitHubGateway } from "../../test/fakes/fake-github.js";
import { CreateFollowUpInputSchema, createFollowUp } from "./create-follow-up.js";

const input = {
  repo: "o/r", pr: 7, reviewedSha: "sha0007",
  title: "Separate parser policy redesign",
  problem: "The requested remediation has grown beyond the original validation change and now requires a separately designed parsing boundary with explicit semantics.",
  rationale: "Keeping that redesign out of this pull request preserves a finite acceptance boundary while retaining the work as an owned improvement.",
  acceptanceCriteria: [
    "Document the accepted grammar and threat model before implementation.",
    "Replace serial wrapper patches with one bounded parser design and corpus.",
  ],
  findingIds: ["shell-policy-parser"],
};

function seeded(): FakeGitHubGateway {
  const gh = new FakeGitHubGateway();
  gh.seedPr({ number: 7, title: "t", author: "me", headSha: "sha0007", baseSha: "b", url: "u", state: "open", labels: [] });
  return gh;
}

describe("createFollowUp", () => {
  it("creates one meaningful issue, links it on the PR, and never creates a second", async () => {
    const gh = seeded();
    const deps = { gh, workspace: { headSha: "sha0007", clean: true } };
    const first = await createFollowUp(deps, input);
    const second = await createFollowUp(deps, { ...input, title: "A different title must not create issue two" });
    expect(first.status).toBe("created");
    expect(second).toEqual({ status: "already-exists", issue: first.issue, url: first.url });
    expect(gh.issues).toHaveLength(1);
    expect(gh.issues[0].title).toContain("Follow-up for #7");
    expect(gh.issues[0].body).toContain("## Acceptance criteria");
    expect(gh.issues[0].body).toContain("shell-policy-parser");
    const comments = await gh.listComments("o/r", 7);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain(`[#${first.issue}](${first.url})`);
  });

  it("rejects issue-shaped noise before touching GitHub", () => {
    const parsed = CreateFollowUpInputSchema.safeParse({
      ...input, title: "cleanup", problem: "refactor later", rationale: "too large", acceptanceCriteria: ["make better"],
    });
    expect(parsed.success).toBe(false);
  });

  it("requires exact clean author state", async () => {
    const dirty = seeded();
    await expect(createFollowUp({ gh: dirty, workspace: { headSha: "sha0007", clean: false } }, input))
      .rejects.toThrow(/dirty/);
    const foreign = seeded();
    foreign.login = "reviewer";
    await expect(createFollowUp({ gh: foreign, workspace: { headSha: "sha0007", clean: true } }, input))
      .rejects.toThrow(/pull request author me/);
  });

  it("recovers an issue created before its PR link without duplicating it", async () => {
    const gh = seeded();
    await gh.createIssue("o/r", {
      title: "[Follow-up for #7] recovered",
      body: "Recovery fixture\n\n<!-- agent-review:follow-up-issue source-pr=7 -->",
    });
    const result = await createFollowUp({ gh, workspace: { headSha: "sha0007", clean: true } }, input);
    expect(result.status).toBe("already-exists");
    expect(gh.issues).toHaveLength(1);
    expect(await gh.listComments("o/r", 7)).toHaveLength(1);
  });
});
