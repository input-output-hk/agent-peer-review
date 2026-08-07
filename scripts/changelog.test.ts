import { describe, it, expect } from "vitest";
import { releaseUnreleased } from "./changelog.js";

const CHANGELOG = `# Changelog

Intro line.

## Unreleased

### Release process
- One-click releases from main.

## 0.4.0

### Configurable reviewers
- A reviewers array.
`;

describe("releaseUnreleased", () => {
  it("promotes Unreleased to the version and seeds a fresh Unreleased", () => {
    const { md, notes } = releaseUnreleased(CHANGELOG, "0.5.0");
    expect(md).toContain("## Unreleased\n\n## 0.5.0\n");
    // The promoted entries stay under the new version heading.
    expect(md).toContain("## 0.5.0\n\n### Release process\n- One-click releases from main.");
    // The prior release is untouched and still below.
    expect(md).toContain("## 0.4.0\n\n### Configurable reviewers");
    expect(md.indexOf("## 0.5.0")).toBeLessThan(md.indexOf("## 0.4.0"));
    // The fresh Unreleased is empty (nothing between it and the version heading but a blank line).
    expect(md).toMatch(/## Unreleased\n\n## 0\.5\.0/);
  });

  it("returns the promoted entries as notes", () => {
    const { notes } = releaseUnreleased(CHANGELOG, "0.5.0");
    expect(notes).toBe("### Release process\n- One-click releases from main.");
  });

  it("throws when there is no Unreleased section", () => {
    expect(() => releaseUnreleased("# Changelog\n\n## 0.4.0\n- old\n", "0.5.0")).toThrow(/no '## Unreleased'/);
  });

  it("throws when Unreleased is empty", () => {
    const empty = "# Changelog\n\n## Unreleased\n\n## 0.4.0\n- old\n";
    expect(() => releaseUnreleased(empty, "0.5.0")).toThrow(/empty/);
  });

  it("handles Unreleased as the final section", () => {
    const trailing = "# Changelog\n\n## Unreleased\n\n- only entry\n";
    const { md, notes } = releaseUnreleased(trailing, "0.5.0");
    expect(notes).toBe("- only entry");
    expect(md).toContain("## Unreleased\n\n## 0.5.0\n\n- only entry");
  });

  it("ignores an H2-like line inside a fenced code block", () => {
    const md = "# Changelog\n\n## Unreleased\n\n- entry\n\n```\n## not a heading\n```\n\n## 0.4.0\n- old\n";
    const { md: out, notes } = releaseUnreleased(md, "0.5.0");
    // The fenced "## not a heading" must not end the section early.
    expect(notes).toContain("- entry");
    expect(notes).toContain("## not a heading");
    expect(notes).not.toContain("old");
    expect(out).toContain("## Unreleased\n\n## 0.5.0\n\n- entry");
    expect(out).toContain("## 0.4.0\n- old");
  });
});
