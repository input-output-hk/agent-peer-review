# Expedition taskflows

Three [pi-taskflow](https://www.npmjs.com/package/pi-taskflow) flows ship with the Pi Package. Each one sweeps a set of repositories, fans out over the pull requests it finds, and reports what it did. They are the scheduled half of this workflow: the [review loop](./lifecycle.md) reacts to a request, and these flows go looking for work.

Every flow is **propose-only by default**. In that mode the agent writes one comment saying what it would do and why it did not do it, and nothing else changes. Merging, approving, and labeling are only ever reachable through this package's typed tools, never through `gh` or `git`, and the tools consult a central safety gate first. See [The safety model](#the-safety-model) below.

## The three flows

### pr-requester

Your own open pull requests. For each one, in order: `pr_stabilize` syncs the branch with its base; `pr_expedite` asks the expedition gate for a verdict and, in propose mode, posts it; and when the gate reports that the change carries source or test paths, `pr_request_review` hands the pull request to an agent peer review. The state model is the pull request itself, as everywhere else in this package: a synced branch, a proposal comment keyed to the head commit, and a native review request. A branch that cannot be synced because of a conflict is escalated to a human and the flow moves on, and a pull request that turns out to be closed or merged is dropped. A pull request whose mergeable state is merely `blocked`, which on a protected repository is the everyday state of one waiting for its required review, is not dropped: the flow carries on to the gate and to the review request, which is the very thing it is blocked on. Drafts are skipped entirely, since a draft is the author's own "not ready" marker.

### pr-reviewer

The reviewer side, in two buckets. Pull requests with a review requested from you run the full claim, review, complete cycle: `review_claim` pins the head SHA and returns the composed review task, and `review_complete` (or `review_enrich` when you are a second reviewer on a [panel](./lifecycle.md#panel-review-multiple-reviewers)) posts the verdict at that pinned SHA. Pull requests you have already reviewed run `pr_watch` instead, which reads state and returns one of exactly six verbs: `re-review` when the head moved after you requested changes, `wait` when nothing has been pushed since your verdict, `hold-for-human` when the round cap is spent or a human review is in flight, `abandoned` when the pull request is closed or merged, `approved` when your approval still stands, and `none` when you have no verdict-bearing review on it at all. Only `re-review` starts another review round; every other verb is reported and left alone. Nothing in this flow can merge.

### pr-steward

Bot dependency upgrades. Every open pull request from an allowlisted bot author goes to `pr_approve_dep_upgrade`, which classifies the change as a dependency upgrade, checks that it really is version-only, and asks the gate. In propose mode it posts the verdict with the semver level and the individual bumps; with autonomy on and every rail satisfied it approves and merges. Major bumps and non-bot authors are `not-eligible` by design and stay for a human.

## Install

pi-taskflow is an **optional peer dependency**, so installing `@input-output-hk/agent-review-pi` does not bring it along. Install it explicitly in the host that will run the flows:

```bash
pi install npm:pi-taskflow
```

or, outside a Pi host, `npm i pi-taskflow`. pi-taskflow requires **Node.js 22.19.0 or newer**, which is stricter than this package's own Node 22 floor.

Then copy the three flows into the repository you want to sweep. They live in the installed package under `@input-output-hk/agent-review-pi/taskflows/`, and this repository keeps a working copy of the same files under [`.pi/taskflows/`](https://github.com/input-output-hk/agent-peer-review/tree/main/.pi/taskflows) that you can copy instead. Each flow is two files plus a directory of four:

```text
.pi/taskflows/pr-steward.json          the flow definition
.pi/taskflows/pr-steward.meta.json     the library sidecar
.pi/taskflows/pr-steward/discover.mjs  finds the candidate pull requests
.pi/taskflows/pr-steward/instructions.md  what the agent may do to one of them
.pi/taskflows/pr-steward/summarize.mjs    counts the results
.pi/taskflows/pr-steward/config.example.json  the repositories to sweep
```

The paths inside each flow definition are repository-relative and point at `.pi/taskflows/<name>/`, so copy the whole directory to that location and the flow resolves without editing. Finally, rename `config.example.json` to `config.json` and list your repositories:

```json
{ "repos": ["input-output-hk/agent-peer-review"], "botAuthors": ["app/dependabot"] }
```

`config.json` is the only file you have to edit. It never carries an autonomy setting; see [The safety model](#the-safety-model).

The discover and summarize scripts are dependency-free Node scripts that shell out to the [GitHub CLI](https://cli.github.com/) with `--json` and read nothing else, so they run in any repository with `gh` authenticated and no `node_modules` at all. The reviewing and expediting work goes through the tools in [pi.dev integration](./pi.md), which need that package installed and configured as usual.

## How to run one

Inside a Pi host, each saved flow gets its own slash command:

```text
/tf:pr-reviewer
/tf:pr-steward autonomy=auto
```

Anywhere pi-taskflow's own tool is available, including MCP hosts, call the `taskflow` tool with `action: "run"`, the flow `name`, and any `args`:

```json
{ "action": "run", "name": "pr-steward", "args": { "autonomy": "propose" } }
```

**pi-taskflow has no scheduler.** Nothing in this package or in pi-taskflow makes a flow recur; a run happens because something asked for one. To sweep on a cadence, drive it from outside: a cron entry or a systemd timer that starts a headless Pi session, a CI schedule, or a Pi loop left running in a session. Each flow is safe to re-run: `pr_stabilize` is a no-op on an up-to-date branch, proposal comments are keyed to the head commit so a re-run at the same head posts nothing and reports `already-proposed`, and `pr_request_review` will not ask a second time for the same round.

## The safety model

**Propose is the default, and it is a flow argument, not configuration.** Every flow declares `autonomy` with the default `propose`, and `config.json` has no autonomy field at all. Turning it up therefore takes an explicit, visible opt-in on the invocation itself, `/tf:pr-steward autonomy=auto`, which lands in that run's record. There is no way to leave a repository permanently in auto by editing a file the flows read.

**The ten-rail gate decides, not the model.** `pr_expedite` and `pr_approve_dep_upgrade` hand every input to one central gate, which merges only when all ten rails agree: the change classifies into the docs, lint, CI, or dependency allowlist and touches no source or test path; it fits the size caps (10 files, 200 lines); required checks are green; GitHub's own mergeable state is clean; branch protection is satisfied; the security-alert rail is satisfied; no human review is in flight; the autonomy for this call is `auto`; the head SHA has not moved since the evaluation; and the acting login is not the pull request's own author. Any single "no" turns the decision into a proposal, with the reason quoted.

The `maxFiles` and `maxLines` parameters on `pr_expedite` can only make the size rail **stricter**. A value above the default cap is clamped down to it, so a caller can never widen its own blast radius in the same call that asks for a merge.

**A proposal comment** carries the decision, the evidence, and a hidden marker that keeps re-runs idempotent:

```markdown
### Proposed action

I would approve and merge this patch dependency upgrade.

- Head commit: `9f2c1a...`
- Change classes: deps
- Semver level: patch
- `undici`: 8.9.0 -> 8.9.1

I did not do it. The safety gate held it back:

- autonomy is "propose", not "auto"

Acting automatically is opt-in and off by default, so this agent stops at a proposal. A maintainer can take the action above by hand, or enable autonomy for this repository.
```

**Autonomy is gated on more than the flag.** The open questions that have to be answered before any repository should run in auto are tracked in [issue #39](https://github.com/input-output-hk/agent-peer-review/issues/39): whether a peer agent's approval can satisfy branch protection, the stale-approval policy, ruleset-protected branches, and the rest. Until those are closed, treat `autonomy=auto` as an experiment you are supervising, not a mode you leave on.

:::note
One consequence is already visible in `pr-steward`. A dependency upgrade rewrites a lockfile, and a realistic lockfile diff is thousands of lines, so the shared 200-line size rail holds the change back and the auto path falls through to a proposal. That is the conservative behavior working as intended, not a bug: the deps-specific size policy that would judge a lockfile by its dependency changes rather than its line count is one of the items in issue #39. Propose mode is unaffected, since it posts the same verdict either way.
:::

## Cost and concurrency

Every flow sets `concurrency: 4`, so at most four pull requests are handled at a time no matter how many the sweep finds. The bound is about budget as much as about rate limits: each item is a separate agent invocation with its own context, and a sweep over a busy organization can otherwise fan out to dozens of concurrent models. Four is the shipped default; edit your copy of the flow if a different number suits your budget, and keep in mind that pi-taskflow can also cap a whole run with its own `budget` field.

The two script phases are free. `discover.mjs` and `summarize.mjs` spend no tokens at all, which is why the flows do the finding and the counting in scripts and reserve the model for the one job that needs judgment: deciding what to do about a single pull request.
