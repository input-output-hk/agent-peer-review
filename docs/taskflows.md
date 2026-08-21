# Expedition taskflows

Three [pi-taskflow](https://www.npmjs.com/package/pi-taskflow) flows ship with the Pi Package. Each one sweeps a set of repositories, fans out over the pull requests it finds, and reports what it did. They are the scheduled half of this workflow: the [review loop](./lifecycle.md) reacts to a request, and these flows go looking for work.

Every flow is **propose-only by default**. In that mode the agent writes one comment saying what it would do and why it did not do it, and nothing else changes. Merging, approving, and labeling are only ever reachable through this package's typed tools, never through `gh` or `git`, and the tools consult a central safety gate first. See [The safety model](#the-safety-model) below.

## The three flows

### pr-requester

Your own open pull requests. For each one, in order: `pr_stabilize` syncs the branch with its base; `pr_expedite` asks the expedition gate for a verdict and, in propose mode, posts it; and whenever the gate refused to merge, `pr_request_review` hands the pull request to an agent peer review. The reviewer step keys on the refusal itself, not on which rail refused: a change carrying source paths, unsatisfied branch protection, a size cap over the limit, and the security-alert rail all leave the pull request equally stuck, and none of them is something the flow can clear by itself. See [What a run reports](#what-a-run-reports). The state model is the pull request itself, as everywhere else in this package: a synced branch, a proposal comment keyed to the head commit, and a native review request. A branch that cannot be synced because of a conflict is escalated to a human and the flow moves on, and a pull request that turns out to be closed or merged is dropped. A pull request whose mergeable state is merely `blocked`, which on a protected repository is the everyday state of one waiting for its required review, is not dropped: the flow carries on to the gate and to the review request, which is the very thing it is blocked on. Drafts are skipped entirely, since a draft is the author's own "not ready" marker.

One pull request this flow never hands to a peer is one authored by a **dependency bot that `pr-steward` handles**. `pr_request_review` returns `bot-authored` and writes nothing at all: no label, no request. GitHub only forbids approving your *own* pull request, so your agent may review and approve such a change itself, and that is `pr-steward`'s job. Asking another engineer's agent to look at a machine-checkable dependency bump adds a round trip and a person's queue for no gain.

The refusal is limited to the same bot allowlist the steward accepts. `pr_request_review` would therefore hand a bot outside that list, a codegen or release bot say, to a peer like anyone else's pull request. Be clear about what that is worth today: **no flow discovers such a pull request in the first place.** `pr-requester` lists only pull requests you authored, `pr-steward` lists only its configured `botAuthors`, and `pr-reviewer` needs someone to have asked you already. So bringing a codegen bot's pull request into this workflow takes a deliberate act: name that author in the steward's `botAuthors` (`pr_approve_dep_upgrade` then reports `not-eligible` for a diff that is not a version-only bump, which is a line in the summary and a decision for a person), or have someone request your agent as a reviewer, which `pr-reviewer` picks up. And keep a flow's `botAuthors` list in step with the tool's allowlist either way, or a pull request the requester declines to hand over can be one the steward never discovers.

### pr-reviewer

The reviewer side, in two buckets. Pull requests with a review requested from you run the full claim, review, complete cycle: `review_claim` pins the head SHA and returns the composed review task, and `review_complete` (or `review_enrich` when you are a second reviewer on a [panel](./lifecycle.md#panel-review-multiple-reviewers)) posts the verdict at that pinned SHA. Pull requests you have already reviewed run `pr_watch` instead, which reads state and returns one of exactly six verbs: `re-review` when the head moved after you requested changes, `wait` when nothing has been pushed since your verdict, `hold-for-human` when your standing verdict was dismissed, the round cap is spent, a human has been asked for a review and not answered, or a human's standing verdict requests changes, `abandoned` when the pull request is closed or merged, `approved` when your approval still stands, and `none` when you have no verdict-bearing review on it at all. Every answer also carries `headMoved`, which says whether your standing verdict was left on a commit that is no longer the head; on `approved` that means the approval is stale, and the merge side will not count it. Only `re-review` starts another review round; every other verb is reported and left alone. The optional `maxReviewRounds` may tighten the built-in cap of three but cannot raise it. Nothing in this flow asks for a merge: its instructions name none of the merge-capable tools and never pass an `autonomy`, those tools default to `propose` on every call, and no file the flows read can turn that default up.

### pr-steward

Bot dependency upgrades. Every open pull request from an allowlisted bot author goes to `pr_approve_dep_upgrade`, which classifies the change as a dependency upgrade, checks that it really is version-only, and asks the gate. In propose mode it posts the verdict with the semver level and the individual bumps; with autonomy on and every rail satisfied it approves and merges. Major bumps and non-bot authors are `not-eligible` by design and stay for a human.

Three things about this flow are specific to it, all of them consequences of its being the one path that **approves** rather than merely merging:

- **Its own pending approval counts, on two rails.** On a repository that requires an approving review, the required approval cannot be present before the operation whose whole job is to add it has run. Two rails were failing for that one reason: rail 5, which compares the standing approvals against the required count, and rail 4, because GitHub reports such a pull request as `blocked` for precisely as long as the review is missing. Both now account for the approval this call is about to submit, and nothing else does. Rail 5 adds exactly one, so a repository requiring two approvals with none present still holds the change back; rail 4 tolerates `blocked` only, never `dirty`, `unstable`, `behind`, or `unknown`. See [The safety model](#the-safety-model).
- **Every rail is re-checked after approving.** Approving is a write, and anything can change while it happens. So the tool approves, re-reads every rail input, and puts the whole gate to the question a second time without the pending-approval allowance, merging only if the gate says `auto` on the state that now really exists. A human review arriving in that window, a check going red, a new security alert, a moved head, or protection that the approval did not in fact satisfy each stop the merge, and the result is `approved`: the approval landed and the merge did not. That is a real outcome rather than a failure, because an approval is durable and unblocks the pull request for whoever merges it next, and the next run tries the merge again.
- **A dependency-specific size policy.** 10 files and 4000 changed lines, instead of the general 200-line cap. Be clear about what that rests on: the manifest lines are read and verified to be nothing but paired dependency version edits, and lockfile content is **not** read at all, by anything in this package. A lockfile is accepted on its file name, and its thousands of changed lines are trusted on the authorship rail instead: an allowlisted dependency bot whose actor type GitHub confirms, regenerating a lockfile from the manifest edit that was verified. The honest description of the change is that at 200 lines a full lockfile regeneration went to a human and at 4000 it does not; a line count was never evidence about lockfile content either way, and the file-count cap and every other rail are unchanged.

The approving review carries the verdict, not just the event: the change class, the semver level, the packages with their old and new versions, the size, the head commit, and which rails passed. The audit trail is a review a human can read and disagree with.

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
{ "repos": ["input-output-hk/agent-peer-review"], "botAuthors": ["app/dependabot", "app/renovate"] }
```

`config.json` is the only file in the flow directory you have to edit. It never carries an autonomy setting; see [The safety model](#the-safety-model).

## Before your first run on a new repository

The flows drive this package's tools, so a repository needs the same setup the review workflow needs, plus one field that only matters once agents review each other. Four things, once per repository or once per machine:

1. **Bootstrap the labels on the target repository**, so the trigger label the reviewer flow keys on exists:

   ```bash
   agent-review labels bootstrap --repo owner/name
   ```

   `agent-review init --repo owner/name` does this too, along with writing the config below. Repeating either is safe: existing labels are reported as `unchanged`. See [Labels](./labels.md).

2. **Name the reviewers** in `~/.agent-peer-review/config.json`. `pr_request_review` takes its reviewer logins from here (or from `AGENT_REVIEW_REVIEWERS`) and fails with a clear error when the list is empty, so `pr-requester` cannot hand a pull request to a peer without it. The `reviewers` field inside a flow's own `config.json` is documentation only; it is never read.

3. **List the peer agents in `knownAgentLogins`.** This is the field to get right when testing across repositories, because the failure is silent rather than loud. The safety gate refuses to act while a human review is in flight, and it decides who is human by exclusion: any login not in `knownAgentLogins` counts as a human. Leave a peer agent's login out and its review reads as a human's, so `pr_watch` returns `hold-for-human` and `pr_expedite` reports a human-review rail failure, on a pull request no human has touched. Both machines in a peer pair should list the other's login.

   ```json
   {
     "reviewers": ["peer-agent-login"],
     "knownAgentLogins": ["peer-agent-login", "my-agent-login"],
     "captureMetadata": true
   }
   ```

   `captureMetadata` is optional and off by default. Turn it on if you want the durable footer that records which model and agent reviewed, which is also what gives the [dashboard](./dashboard.md) something better than "unknown" to attribute a review to. It writes that metadata into the public review body, so enable it only where that is acceptable.

4. **Authenticate the GitHub CLI** (`gh auth login`) or export `GITHUB_TOKEN`. The discover scripts shell out to `gh`. Beyond the review flow's pull-request and issue access, the expedition gate needs Checks, Commit statuses, Administration, and Dependabot alerts read access on every repository swept. Auto-merge also needs Contents write. See [`SECURITY.md`](https://github.com/input-output-hk/agent-peer-review/blob/main/SECURITY.md#additional-scope-for-expedition-taskflows) for the exact fine-grained and classic-token scopes.

A quick way to check the discovery half before involving a model at all: run a flow's discover script directly. It spends no tokens, prints its candidate count to stderr, and emits the candidate array on stdout.

```bash
node .pi/taskflows/pr-reviewer/discover.mjs
```

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

## What a run reports

Every flow ends with one counts line and, under it, one line for each pull request that needs a person. Read the second part. Those lines are the only place some outcomes appear at all: a hand-off that writes nothing on the pull request, or a tool that refused before its first GitHub call, exists nowhere else, and a counts line can look healthy while a pull request is permanently stuck.

The case those lines exist for is a pull request that was neither merged nor handed to anybody. `pr-requester` asks for a peer review whenever the gate refused and nobody has been asked yet, whatever the refusal was, so that case should be rare. Three outcomes still end without a reviewer, and each one now names itself:

| Line under the counts | What it means | What to do about it |
| --- | --- | --- |
| `no reviewers are configured, so nobody was asked` | `requested: "unconfigured"`. `pr_request_review` throws before its first GitHub call when no reviewer list is configured, so nothing was written anywhere and the pull request carries no trace of the attempt. | Set `reviewers` in `~/.agent-peer-review/config.json`, or export `AGENT_REVIEW_REVIEWERS`. See [Before your first run](#before-your-first-run-on-a-new-repository). |
| `held for a review in flight` | A review the gate reads as a human's is holding the decision: either an open review request nobody has answered, or a standing `CHANGES_REQUESTED`. Counted as `human-review-hold`. | Nothing, if a person really is reviewing. If nobody is, a peer agent is missing from `knownAgentLogins`, and the hold lasts as long as that state does: an open request until it is answered, a refusal until that person replaces the verdict. Neither clears on its own while the login is misread as a human's. |
| `the gate never ran` | `expedite: "not-eligible"`: the pull request turned out to be closed, merged, or a draft, so no rail was evaluated. | Nothing, beyond confirming that is the state you expect. |
| `proposed, and no reviewer was asked` | The gate refused and the item still ended with nobody engaged. | Read the run's log. The executor did not do what the flow's step 3 tells it to. |

One outcome deliberately gets no line: `requested: "bot-authored"`, which is a hand-off to `pr-steward` rather than a strand, and `pr-steward` reports on it in its own run.

`human-review-hold` is a breakdown rather than a separate outcome, in all three flows: an item counted there is also counted as `proposed` (or, in `pr-reviewer`, as `held-for-human`). It is broken out because it is the one rail an operator can trip through configuration alone, and because "the gate is waiting for a human" and "the gate is waiting forever" are indistinguishable in any other number.

## The safety model

**Propose is the default, and it is a flow argument, not configuration.** Every flow declares `autonomy` with the default `propose`, and `config.json` has no autonomy field at all. Turning it up therefore takes an explicit, visible opt-in on the invocation itself, `/tf:pr-steward autonomy=auto`, which lands in that run's record. There is no way to leave a repository permanently in auto by editing a file the flows read.

**The ten-rail gate decides, not the model.** `pr_expedite` and `pr_approve_dep_upgrade` hand every input to one central gate, which merges only when all ten rails agree: the change classifies into the docs, lint, CI, or dependency allowlist and touches no source or test path (the CI class is narrower than its name suggests: everything under `.github/workflows/` or `.github/actions/` is classified `source`, as is any file with an executable extension wherever it lives, so a workflow or action edit is never auto-eligible. What is left in the CI class is non-executing GitHub configuration, such as `dependabot.yml`, `CODEOWNERS`, and issue templates); it fits the size caps (10 files and 200 lines by default, 10 files and 4000 lines for a dependency upgrade); required checks are green; GitHub's own mergeable state is clean (or `blocked`, when the decision is the approval that would clear it, see below); branch protection is satisfied; the security-alert rail is satisfied; no human has been asked for a review and not answered, and no human's standing verdict requests changes; the autonomy for this call is `auto`; the head SHA has not moved since the evaluation; and, when the decision is an approval (`pr_approve_dep_upgrade`), the acting login is not the pull request's own author. Any single "no" turns the decision into a proposal, with the reason quoted.

That last rail is conditional on purpose, and it is worth being clear about what it does not do: `pr_expedite` merges rather than approves, so it does not apply there, and `pr-requester` exists precisely to move **your own** pull requests forward. With `autonomy=auto` on that flow, the gate can merge a pull request you authored, once the other nine rails agree. Whether that is acceptable is the operator's call to make deliberately, and branch protection (rail 5) is where a repository states that it is not.

**Rails 4 and 5 count the approval the approver is about to add.** Every rail is read before anything is written, so on a repository that requires an approving review the required approval is by definition absent at that moment. Demanding it there would make the operation that supplies the approval unable to satisfy the requirement its own approval exists to satisfy, and it showed up on two rails, because GitHub states the same missing review in two places:

- **Rail 5**, which compares the standing approvals against the required count.
- **Rail 4**, GitHub's own `mergeStateStatus`, which reads `blocked` for exactly as long as a required review is missing. That is the same fact `pr_stabilize` reports as its own `blocked` status, and the everyday state of a pull request waiting for review.

So when the decision **is** an approval, both rails account for that one pending approval, and only then. Everything about them that could hide a real problem is unchanged. Rail 5 adds exactly one, so two required approvals with none present still fails; protection that cannot be read at all still fails closed; required conversation resolution still fails closed; required checks must still be green; a nonsensical approval count is still rejected before the increment is applied. Rail 4 tolerates `blocked` and nothing else: `dirty` (a conflict), `unstable` (a failing non-required check), `behind`, and `unknown` all still refuse, because approving would not change any of them. And both allowances are withheld entirely when the acting login is the author (whose approval GitHub would refuse) or already holds a standing approval (which is counted once, not twice). `pr_expedite` merges rather than approves and passes no such claim, so its rails 4 and 5 are exactly what they always were.

Rail 4's tolerance carries one honest caveat: `mergeStateStatus` does not say **why** a pull request is blocked. A missing required review is the common cause and the one being fixed, but a repository ruleset this package cannot read could be the real reason. That is exactly why the tolerance buys the approval and never the merge.

Because those allowances describe a state which does not yet exist, they authorize the approval and nothing more. `pr_approve_dep_upgrade` approves first, then re-reads every rail input and runs the **whole gate** again **without** the allowance, and merges only if that second evaluation returns `auto`. Putting the gate itself to the question, rather than a short list of rails worth re-reading, is deliberate: the window between approving and merging is long enough for a human to post a review, a check to go red, or an alert to appear, and a rail added to the gate later is re-checked here without anyone having to remember it. When the second evaluation refuses, the result is `approved` rather than `approved-and-merged`, and it names the rail that refused.

The `maxFiles` and `maxLines` parameters on `pr_expedite` and `pr_approve_dep_upgrade` can only make the size rail **stricter**. A value above that tool's own cap is clamped down to it, so a caller can never widen its own blast radius in the same call that asks for a merge.

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

**Rail 7 asks two questions, and a finished favourable review is neither.** "Do not race a human" and "do not act against a human's refusal" are different facts, and the rail reads them separately. A human with an open review request has been asked and has not answered: that is the only state anything can be raced, and it fails the rail as `a human review is in flight`. A human whose standing verdict is `CHANGES_REQUESTED` has finished and said no: that fails the rail too, as `a human has requested changes`, until they replace that verdict with another one. What does **not** fail it is a human's standing `APPROVED`, which is the outcome the whole workflow is for and already counts toward rail 5, or a comment-only review, which states no position on the change. Reading any human review as an obstacle made this rail fail on the same event that satisfied rail 5, so on every repository where a human ever reviews the auto path was unreachable, permanently, because a GitHub review is history that cannot be undone ([issue #57](https://github.com/input-output-hk/agent-peer-review/issues/57)). An unlisted login is still assumed to be a human; that part was never the bug.

**Rail 5 counts approvals of the code that would merge.** A peer approves `sha0001`, the author pushes `sha0009`, and the approval of `sha0001` says nothing about `sha0009`. So an approving review whose commit is not the current head is not counted, and the change proposes instead of merging until someone approves the head ([issue #53](https://github.com/input-output-hk/agent-peer-review/issues/53)). The one exception is a branch with `dismiss_stale_reviews` enabled, where GitHub retires approvals on every push and has therefore already answered the question. A refusal is treated the other way round on purpose: an approval of an old commit does not **count**, while a `CHANGES_REQUESTED` on an old commit still **blocks**, because each rule fails toward not acting. The approval `pr_approve_dep_upgrade` is itself about to submit is unaffected, since it is by definition an approval of the head it just evaluated.

**Autonomy is gated on more than the flag.** The open questions that have to be answered before any repository should run in auto are tracked in [issue #39](https://github.com/input-output-hk/agent-peer-review/issues/39). Three of them are now answered: how a required approving review is satisfied by the operation that supplies the approval (rail 5 above, with the post-approval re-check), the dependency-specific size policy, and the stale-approval policy, which is now "refuse rather than merge" as described above. Re-affirming a stale approval on the reviewer side, ruleset-protected branches, and the rest are still open. Until those are closed, treat `autonomy=auto` as an experiment you are supervising, not a mode you leave on.

:::note
`pr-steward` used to be held back three times over on exactly the repositories it is for. A required approving review made rail 5 unsatisfiable for the one operation whose approval would satisfy it; the same missing review made GitHub report the pull request as `blocked`, which failed rail 4 for the same reason one rail over; and a realistic lockfile diff of thousands of lines failed the shared 200-line size rail. All three are addressed above, and none of the loosenings is a bypass: the approval is a real action GitHub counts, the tolerances buy the approval and never the merge, every rail is re-checked afterwards without them, and the dependency size policy leaves the file cap and every other rail alone. Propose mode is unaffected either way, since it posts the same verdict.
:::

## Cost and concurrency

Every flow sets `concurrency: 4`, so at most four pull requests are handled at a time no matter how many the sweep finds. The bound is about budget as much as about rate limits: each item is a separate agent invocation with its own context, and a sweep over a busy organization can otherwise fan out to dozens of concurrent models. Four is the shipped default; edit your copy of the flow if a different number suits your budget, and keep in mind that pi-taskflow can also cap a whole run with its own `budget` field.

The two script phases are free. `discover.mjs` and `summarize.mjs` spend no tokens at all, which is why the flows do the finding and the counting in scripts and reserve the model for the one job that needs judgment: deciding what to do about a single pull request.
