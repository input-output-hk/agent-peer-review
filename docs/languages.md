---
sidebar_position: 5
---

# Languages

A programming language is never a skill label. `review.claim` detects every language a pull request touches directly from its changed files, by extension, and loads the matching checklist automatically. There is nothing to request and nothing to bootstrap.

## The 12 languages

| Language | Skill file | Extensions |
| --- | --- | --- |
| TypeScript | `skills/lang/typescript.md` | `.ts`, `.tsx`, `.mts`, `.cts` |
| JavaScript | `skills/lang/javascript.md` | `.js`, `.jsx`, `.mjs`, `.cjs` |
| Python | `skills/lang/python.md` | `.py`, `.pyi` |
| Go | `skills/lang/go.md` | `.go` |
| Rust | `skills/lang/rust.md` | `.rs` |
| Haskell | `skills/lang/haskell.md` | `.hs`, `.lhs` |
| Java | `skills/lang/java.md` | `.java` |
| Kotlin | `skills/lang/kotlin.md` | `.kt`, `.kts` |
| Swift | `skills/lang/swift.md` | `.swift` |
| Scala | `skills/lang/scala.md` | `.scala`, `.sc` |
| C / C++ | `skills/lang/c-cpp.md` | `.c`, `.h`, `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`, `.hxx` |
| Solidity | `skills/lang/solidity.md` | `.sol` |

Both C and C++ map to the single `c-cpp` skill: the two languages share enough of the same review concerns, memory safety and undefined behavior chief among them, to warrant one checklist rather than two nearly identical ones.

Read the full checklist for any language on the [Skills](./skills.mdx) page, under "Language skills".

## How auto-detection works

1. `review.claim` lists every file changed in the pull request.
2. Each file's extension is looked up in the table above, case-insensitively. A file with no extension, or an extension not in the table, contributes no language and never fails the claim; it is simply ignored.
3. The matched language names are deduplicated and sorted, then returned in the composed review task's top-level `languages` field.
4. The full checklist for each matched language, read from its `skills/lang/<name>.md` file, is embedded in `instructions.languages[]`, alongside `instructions.review` and any label-matched `instructions.skills[]`.

:::note[Migrating from an older request]
Earlier versions treated `rust` as a selectable domain skill: a `--skills rust` label you had to request explicitly. It is now detected automatically like every other language in the table above, so `--skills rust` is silently ignored as an unrecognized skill name, and no `rust` label exists to bootstrap. Touching a `.rs` file in the pull request is what loads the Rust checklist today, not requesting it.
:::

See the `orchestration` skill on the [Skills](./skills.mdx) page for how a reviewing agent should combine this with `repoContext`, the reviewed repository's own conventions.
