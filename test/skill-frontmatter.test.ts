import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// js-yaml v4's `load` is the safe loader: `safeLoad` was removed in v4 because `load` no longer
// constructs arbitrary types (that needs an explicit non-default schema). It is also the exact call
// a host makes, which matters here: a stricter parser than the host's would fail on frontmatter the
// host would have accepted, and this test exists to predict the host, not to out-police it.
import yaml from "js-yaml";

/**
 * Every skill file this repository publishes carries YAML frontmatter, and a host reads that
 * frontmatter to decide whether to load the skill at all. A file whose frontmatter does not parse
 * is not a cosmetic problem: the skill silently fails to load, and nothing else in this suite
 * notices, because nothing else parses it.
 *
 * That happened. Version 0.5.0 shipped `pi/skills/agent-review/SKILL.md` with a long unquoted
 * `description` whose text contained `": "` (from "Drives the full loop: list open requests"),
 * which YAML reads as a nested mapping inside a plain one. Every parser rejects it, so pi refused
 * the skill at startup for anyone who installed that version. The release checks in place at the
 * time (tests, version consistency, changelog, advisories) could not have caught it: none of them
 * ever parsed the file. See issue #47.
 *
 * So this test parses the frontmatter of every shipped skill with a real YAML parser, which is the
 * only check that would have failed on that release.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The skill directories named in the two published packages' `files` fields. A skill that ships
// has to parse; a scratch markdown file elsewhere in the repository does not.
const SHIPPED_SKILL_DIRS = ["skills", path.join("pi", "skills")];

function markdownFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const p = path.join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith(".md") || entry.endsWith(".mdx")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** The frontmatter block of a markdown file, or null when it has none. */
function frontmatter(file: string): string | null {
  const text = readFileSync(file, "utf8");
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  return end === -1 ? null : text.slice(4, end);
}

const shipped = SHIPPED_SKILL_DIRS.flatMap((d) => markdownFilesUnder(path.join(ROOT, d)));

describe("shipped skill frontmatter", () => {
  it("finds the skill files it is supposed to be guarding", () => {
    // A refactor that moves the skills must break this test rather than silently guarding nothing.
    expect(shipped.length).toBeGreaterThan(0);
    expect(shipped.some((f) => f.endsWith(path.join("pi", "skills", "agent-review", "SKILL.md")))).toBe(true);
  });

  it.each(shipped.map((f) => path.relative(ROOT, f)))("%s has frontmatter a YAML parser accepts", (rel) => {
    const fm = frontmatter(path.join(ROOT, rel));
    if (fm === null) return; // not every shipped markdown file declares frontmatter
    // The assertion is that this does not throw. yaml.load is the same call a host makes.
    const parsed = yaml.load(fm);
    expect(parsed, `${rel}: frontmatter parsed to a non-object`).toBeTypeOf("object");
  });

  it("keeps a name and a description on every skill that declares frontmatter", () => {
    for (const file of shipped) {
      const fm = frontmatter(file);
      if (fm === null) continue;
      const parsed = yaml.load(fm) as Record<string, unknown>;
      const rel = path.relative(ROOT, file);
      expect(typeof parsed.name, `${rel}: missing or non-string name`).toBe("string");
      expect(typeof parsed.description, `${rel}: missing or non-string description`).toBe("string");
    }
  });
});
