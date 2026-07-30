# Contributing a skill

1. Add `skills/<name>.md` with a `# <Name> Review` heading and a focused checklist.
2. Add `<name>` to `SKILL_NAMES` in `core/labels.ts`.
3. Re-run `agent-review labels bootstrap` so the `<name>` label exists.

No changes to the review loop are needed. Unknown labels are ignored, so older agents keep working.
