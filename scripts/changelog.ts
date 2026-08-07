import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface Released {
  /** The rewritten CHANGELOG: a fresh empty `## Unreleased`, then `## <version>` with the captured entries. */
  md: string;
  /** The released section's entries, for use as GitHub release notes. */
  notes: string;
}

const UNRELEASED = /^##\s+Unreleased\s*$/i;
const ANY_H2 = /^##\s+/;
const FENCE = /^\s*(```|~~~)/;

/**
 * Promote the `## Unreleased` section to `## <version>` and seed a new empty
 * `## Unreleased` above it. Returns the rewritten changelog and the promoted
 * entries as release notes. Throws if there is no Unreleased section or it is empty. Pure.
 */
export function releaseUnreleased(md: string, version: string): Released {
  const lines = md.split("\n");

  // Locate the Unreleased heading and the next H2, ignoring headings that fall
  // inside fenced code blocks (a "## x" line inside a ``` fence is not a section).
  let fenced = false;
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (start === -1) {
      if (UNRELEASED.test(lines[i])) start = i;
    } else if (ANY_H2.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (start === -1) throw new Error("no '## Unreleased' section in CHANGELOG.md");

  const body = lines.slice(start + 1, end);
  const notes = body.join("\n").trim();
  if (!notes) throw new Error("'## Unreleased' is empty; add entries before releasing");

  const rebuilt = [
    ...lines.slice(0, start),
    "## Unreleased",
    "",
    `## ${version}`,
    ...body,
    ...lines.slice(end),
  ];
  return { md: rebuilt.join("\n"), notes };
}

function main(argv: string[]): void {
  const args = argv.slice(2);
  if (args[0] !== "release" || !args[1]) {
    throw new Error("usage: changelog release <version> [--notes-out <file>]");
  }
  const version = args[1];
  const notesOutIdx = args.indexOf("--notes-out");
  const notesOut = notesOutIdx !== -1 ? args[notesOutIdx + 1] : null;

  const file = path.join(ROOT, "CHANGELOG.md");
  const { md, notes } = releaseUnreleased(readFileSync(file, "utf8"), version);
  writeFileSync(file, md);
  if (notesOut) writeFileSync(notesOut, notes + "\n");
  else process.stdout.write(notes + "\n");
  console.error(`Finalized CHANGELOG.md: ## Unreleased -> ## ${version}`);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main(process.argv);
