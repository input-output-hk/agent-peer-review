---
name: agent-review-default
description: Default PR review applied when no specialty skill label is present.
---

# Default Review

Review the diff at the pinned commit for: **correctness**, **clarity/style**, **performance**, **test coverage**, and **security**.

## Host shortcut (Claude Code)

Inside Claude Code you may delegate the analysis to the built-in reviewer and capture its output as your findings:

```bash
claude -p "/review <PR_NUMBER>" --dangerously-skip-permissions --setting-sources "" --output-format text
```

## Portable checklist (any host)

- **Correctness:** logic errors, off-by-one, null/undefined, error paths, race conditions.
- **Clarity:** naming, dead code, needless complexity; does it match surrounding style?
- **Performance:** obvious hotspots, N+1 calls, unbounded allocations.
- **Tests:** are new code paths covered? Do tests assert behavior, not implementation?
- **Security:** input validation, authz, secrets, unsafe dependencies (see the `security` skill for depth).

Produce a concise summary and, where useful, inline comments as `{path, line, body}`. Choose an event: `approve`, `request-changes`, or `comment`.
