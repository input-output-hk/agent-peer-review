import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (file: string): string => readFileSync(path.join(root, file), "utf8");

const CANONICAL_PARAGRAPH = "Prefer a finite, convergent review over adversarial novelty. Findings must describe root causes, not an endless sequence of examples. On re-review, first dispose every prior finding. New blockers require confirmed exact-head evidence, clear PR scope, and a bounded remediation. Pre-existing issues, speculative hardening, design preferences, and accepted safety trade-offs are non-blocking unless the PR worsens or explicitly owns them. If remediation complexity grows disproportionately, stop and request a design decision instead of prescribing another patch.";

describe("review convergence packaging", () => {
  it("keeps one canonical contract and makes specialty skills layer onto it", () => {
    const sources = ["skills/review.md", "skills/security.md", "skills/testing.md", "skills/second-opinion.md"];
    const occurrences = sources.reduce((count, file) => count + read(file).split(CANONICAL_PARAGRAPH).length - 1, 0);
    expect(occurrences).toBe(1);
    expect(read("skills/review.md")).toContain(CANONICAL_PARAGRAPH);
    for (const file of sources.slice(1)) expect(read(file)).toMatch(/default review skill/i);
  });

  it("keeps dogfood taskflows byte-identical to the Pi package templates", () => {
    for (const file of [
      "pr-requester.json", "pr-requester/instructions.md", "pr-requester/summarize.mjs",
      "pr-reviewer/instructions.md",
    ]) {
      expect(read(`.pi/taskflows/${file}`)).toBe(read(`pi/taskflows/${file}`));
    }
  });

  it("routes every review host through exact-head structured history instead of copying policy", () => {
    for (const file of [
      "skills/orchestration.md", "pi/skills/agent-review/SKILL.md",
      ".pi/taskflows/pr-reviewer/instructions.md",
    ]) {
      const source = read(file);
      for (const field of ["instructions.review", "reviewHistory", "reviewedSha", "mode", "findings", "workspace"]) {
        expect(source, `${file} must route ${field}`).toContain(field);
      }
      expect(source).not.toContain(CANONICAL_PARAGRAPH);
    }
  });

  it("ships the author gate and the single meaningful follow-up in both requester copies", () => {
    const requester = read("pi/taskflows/pr-requester/instructions.md");
    for (const invariant of ["pr_self_review", "pr_create_followup", "one meaningful", "needs-changes", "self-review-required"]) {
      expect(requester).toContain(invariant);
    }
  });
});
