# Labels & routing

Routing is **native** — you request the review from an engineer using GitHub's normal Reviewers field. Labels carry only two things:

| Purpose | Label(s) |
| --- | --- |
| Trigger (required) | `agent` |
| Skill (0..n, optional) | bare names: `security`, `architecture`, `performance`, `testing`, `api`, `rust`, `react-native`, `did`, `oid4vc`, `cryptography`, `documentation` |

There are no `review`, `reviewer:*`, `skill:*`, or status labels. A basic request is `agent` + a requested reviewer. Skill labels are matched only against the known set above; any other label is ignored. Run `agent-review labels bootstrap` to create them.
