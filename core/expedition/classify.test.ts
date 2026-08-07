import { describe, it, expect } from "vitest";
import { classifyChange, type Category } from "./classify.js";

describe("classifyChange", () => {
  describe("category rules", () => {
    it.each<[string, Category]>([
      // docs
      ["README.md", "docs"],
      ["notes.MD", "docs"], // extension match is case-insensitive
      ["guide.mdx", "docs"],
      ["docs/intro.png", "docs"], // anything under docs/, regardless of extension
      ["packages/foo/docs/x.png", "docs"], // nested docs/ dir, not just repo-root
      ["LICENSE", "docs"],
      ["packages/foo/LICENSE", "docs"],
      ["NOTES.txt", "docs"],
      ["NOTES.TXT", "docs"], // extension match is case-insensitive
      // ci (non-executing GitHub config only; workflows/ and actions/ are covered separately below,
      // as they are an escape-to-source guard, not a plain "ci" example)
      [".github/dependabot.yml", "ci"],
      [".github/ISSUE_TEMPLATE/config.yml", "ci"],
      // lint (non-executable config formats only; JS-flavored variants are covered separately
      // below, as they are an escape-to-source guard, not a plain "lint" example)
      [".eslintrc", "lint"],
      [".eslintrc.json", "lint"],
      [".eslintrc.yml", "lint"],
      [".prettierrc", "lint"],
      [".prettierrc.json", "lint"],
      [".prettierignore", "lint"],
      [".editorconfig", "lint"],
      // deps
      ["package-lock.json", "deps"],
      ["dashboard/package-lock.json", "deps"], // nested (workspace) lockfile
      ["yarn.lock", "deps"],
      ["pnpm-lock.yaml", "deps"],
      // test
      ["foo.test.ts", "test"],
      ["foo.test.tsx", "test"],
      ["foo.spec.ts", "test"],
      ["__tests__/foo.ts", "test"],
      ["test/foo.ts", "test"],
      ["tests/foo.ts", "test"],
      ["src/test/foo.ts", "test"], // nested test/ dir, not just repo-root
      // source (the conservative default)
      ["src/index.ts", "source"],
      ["package.json", "source"],
      ["tsconfig.json", "source"],
      ["tsconfig.build.json", "source"],
      ["Makefile", "source"],
      ["src/weird.xyz", "source"],
      ["src/testing-utils.ts", "source"], // contains "test" but is not a test file or test/ dir
    ])("classifies %s as %s", (file, category) => {
      expect(classifyChange([file]).byFile[0]).toEqual({ file, category });
    });
  });

  it("classifies a test file as test, not source, even though it is a .ts file (test is checked before source)", () => {
    const result = classifyChange(["src/foo.test.ts"]);
    expect(result.byFile[0].category).toBe("test");
    expect(result.sawSourceOrTest).toBe(true);
    expect(result.autoEligible).toBe(false);
  });

  it("classifies an unmatched/unknown path as source, the conservative default", () => {
    const result = classifyChange(["random/path/of/unknown/shape"]);
    expect(result.byFile[0].category).toBe("source");
    expect(result.autoEligible).toBe(false);
  });

  it("classifies package.json as source, not deps (a path alone cannot prove a dependency bump)", () => {
    const result = classifyChange(["package.json"]);
    expect(result.byFile[0].category).toBe("source");
    expect(result.sawSourceOrTest).toBe(true);
    expect(result.autoEligible).toBe(false);
  });

  it("a docs-only diff is auto-eligible", () => {
    const result = classifyChange(["README.md", "docs/guide.md", "LICENSE"]);
    expect(result.autoEligible).toBe(true);
    expect(result.sawSourceOrTest).toBe(false);
    expect(result.categories).toEqual(["docs"]);
  });

  it("a lockfile-only diff is auto-eligible", () => {
    const result = classifyChange(["package-lock.json"]);
    expect(result.autoEligible).toBe(true);
    expect(result.sawSourceOrTest).toBe(false);
    expect(result.categories).toEqual(["deps"]);
  });

  it("a diff mixing several allowlisted categories (docs+lint+ci+deps) is still auto-eligible", () => {
    const result = classifyChange(["README.md", ".github/dependabot.yml", "package-lock.json", ".eslintrc.json"]);
    expect(result.autoEligible).toBe(true);
    expect(result.sawSourceOrTest).toBe(false);
    expect(result.categories).toEqual(["docs", "lint", "ci", "deps"]);
  });

  it("a diff mixing a source file with docs is NOT auto-eligible and sawSourceOrTest is true", () => {
    const result = classifyChange(["README.md", "src/index.ts"]);
    expect(result.autoEligible).toBe(false);
    expect(result.sawSourceOrTest).toBe(true);
    expect(result.categories).toEqual(["docs", "source"]);
    expect(result.byFile).toEqual([
      { file: "README.md", category: "docs" },
      { file: "src/index.ts", category: "source" },
    ]);
  });

  it("a diff mixing a test file with docs is NOT auto-eligible and sawSourceOrTest is true", () => {
    const result = classifyChange(["README.md", "src/index.test.ts"]);
    expect(result.autoEligible).toBe(false);
    expect(result.sawSourceOrTest).toBe(true);
    expect(result.categories).toEqual(["docs", "test"]);
  });

  it("an empty file list is not auto-eligible", () => {
    const result = classifyChange([]);
    expect(result.autoEligible).toBe(false);
    expect(result.sawSourceOrTest).toBe(false);
    expect(result.categories).toEqual([]);
    expect(result.byFile).toEqual([]);
  });

  // Escape-to-source guards: executable code and CI-executing workflow/action definitions are
  // never auto-eligible, no matter how "safe" their directory or neighboring filename looks.
  describe("escape-to-source guards", () => {
    it.each<[string, Category]>([
      // guard (a): executable extension, regardless of directory
      ["docs/build.ts", "source"],
      ["docs/deploy.sh", "source"],
      [".github/scripts/release.js", "source"],
      ["eslint.config.ts", "source"],
      [".eslintrc.js", "source"],
      [".prettierrc.js", "source"],
      // guard (a), extra coverage beyond the pinned set above
      [".eslintrc.cjs", "source"], // CommonJS is still executable JS
      ["eslint.config.mjs", "source"], // ESM is still executable JS
      ["docs/Notes.PY", "source"], // extension match is case-insensitive, same as other categories
      ["docs/Main.java", "source"], // not in the brief's literal extension list; covered via the LANGUAGE_EXTENSIONS reuse
      ["docs/Contract.sol", "source"], // ditto: Solidity, reused from LANGUAGE_EXTENSIONS
      // guard (b): workflow/action directory, regardless of extension
      [".github/workflows/ci.yml", "source"],
      [".github/actions/setup/action.yml", "source"],
      [".github/actions/setup/action.yaml", "source"],
      [".github/workflows/README.md", "source"], // even a non-YAML file under workflows/ is source
    ])("classifies %s as %s (never its path-implied category)", (file, category) => {
      const result = classifyChange([file]);
      expect(result.byFile[0].category).toBe(category);
      expect(result.autoEligible).toBe(false);
    });

    it.each<[string, Category]>([
      // unaffected: these remain in their allowlisted category and stay auto-eligible
      ["docs/guide.md", "docs"],
      ["README.md", "docs"],
      [".github/dependabot.yml", "ci"],
      [".eslintrc.json", "lint"],
      [".prettierrc.yaml", "lint"],
      ["package-lock.json", "deps"],
    ])("still classifies %s as %s and auto-eligible (unaffected by the guards)", (file, category) => {
      const result = classifyChange([file]);
      expect(result.byFile[0].category).toBe(category);
      expect(result.autoEligible).toBe(true);
    });

    it("a mix of otherwise-allowlisted files plus one guard(a)-caught executable file is NOT auto-eligible", () => {
      const result = classifyChange(["README.md", ".github/dependabot.yml", "package-lock.json", ".github/scripts/release.js"]);
      expect(result.autoEligible).toBe(false);
      expect(result.sawSourceOrTest).toBe(true);
      expect(result.byFile.find((f) => f.file === ".github/scripts/release.js")?.category).toBe("source");
    });

    it("a mix of otherwise-allowlisted files plus one guard(b)-caught workflow file is NOT auto-eligible", () => {
      const result = classifyChange(["README.md", "package-lock.json", ".github/workflows/ci.yml"]);
      expect(result.autoEligible).toBe(false);
      expect(result.sawSourceOrTest).toBe(true);
      expect(result.byFile.find((f) => f.file === ".github/workflows/ci.yml")?.category).toBe("source");
    });

    it("a diff confined to non-executable, non-workflow docs/lint/ci/deps files is still auto-eligible", () => {
      const result = classifyChange(["README.md", ".github/dependabot.yml", ".eslintrc.json", "package-lock.json"]);
      expect(result.autoEligible).toBe(true);
      expect(result.categories).toEqual(["docs", "lint", "ci", "deps"]);
    });
  });

  describe("test-file detection is linear (ReDoS-safe)", () => {
    it("classifies *.test.* / *.spec.* by a middle dot-segment, not a backtracking regex", () => {
      // A middle "test"/"spec" segment marks a test file, even with a non-code extension.
      expect(classifyChange(["foo.test.md"]).byFile[0].category).toBe("test");
      expect(classifyChange(["report.spec.mdx"]).byFile[0].category).toBe("test");
      // "test"/"spec" only as the first or last segment does NOT mark a test file.
      expect(classifyChange(["test.md"]).byFile[0].category).toBe("docs");
      expect(classifyChange(["foo.test"]).byFile[0].category).toBe("source");
    });

    it("does not backtrack on a pathological path (many '.spec.' repetitions)", () => {
      // The input shape CodeQL flagged for the old regex; the linear scan returns at once, so the
      // test simply completing (rather than timing out) is the regression guard.
      const evil = ".test." + ".spec.".repeat(100000) + "ts";
      expect(classifyChange([evil]).byFile[0].category).toBe("test");
    });
  });
});
