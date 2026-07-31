---
title: "ADR 0005: Review context loading"
sidebar_label: "0005. Review context loading"
---

## Status

Accepted.

## Context

A review is only as good as the context behind it. Domain skills selected by label, as in [ADR 0002](0002-labels-and-native-reviewer-routing.md), cover neither the programming language actually touched nor the reviewed repository's own conventions, and any added context-gathering step must never be allowed to break the claim itself.

## Decision

`review.claim` assembles three sources of context and serves all of them in the composed review task. Language skills are auto-detected from the pull request's changed files: `detectLanguages` (`core/languages.ts`) maps file extensions against a table of 12 languages, TypeScript, JavaScript, Python, Go, Rust, Haskell, Java, Kotlin, Swift, Scala, C/C++, and Solidity, with no label required, and the matched `skills/lang/<name>.md` checklists land in `instructions.languages`. Repository context is fetched from the reviewed repo itself at the pinned SHA (`gatherRepoContext`, `core/repo-context.ts`): exact files (`AGENT.md`, `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`) plus a shallow, one-level listing of `.claude/`, `.codex/`, and `.claude/skills/*` for markdown files, bounded to a 10-file cap and a 64 KB total size cap, with missing paths skipped silently. All three sources are wrapped in try/catch inside `claimReview`; any detection or fetch failure degrades to an empty array, `languages: []`, `repoContext: []`, and never throws, so a context error can never fail a claim.

## Consequences

Reviews get auto-detected language guidance and repo-specific conventions with zero configuration, and the same context reaches every host because it travels inside the composed task rather than living in per-host files. The caps are a deliberate ceiling: a repository with more relevant markdown than the caps allow gets a partial, best-effort slice, and the orchestration skill's instruction to also read the local checkout is the intended supplement for whatever the API fetch missed or capped.
