# Review metadata capture

`captureMetadata` is an opt-in config switch, off by default, that makes the review workflow write
a durable, machine-readable record of who and what produced each review: model, agent, tool
version, verdict, role, machine, claim time, and whether the review posted after the pull request
had already moved on (drift). With it off, the workflow behaves exactly as it did before this
field existed.

## What it is

Turning `captureMetadata` on changes two things:

1. The claim-marker comment `review.claim` posts upgrades from v1 to v2, gaining three optional
   fields, `model`, `agent`, and `toolVersion`, alongside the existing `reviewer`, `machine`,
   `sha`, and `claimedAt`.
2. `review.complete` and `review.enrich` append a hidden footer to the review body:

   ```html
   <!-- agent-review:meta {"v":1,"role":"primary","verdict":"approve","model":"claude-opus-4-8","agent":"claude-code","machine":"reviewer-host","claimedAt":"2026-08-01T12:00:00Z"} -->
   ```

   The footer carries `role`, `verdict`, `model`, `agent`, `toolVersion`, `machine`, `claimedAt`,
   and `drifted`. It is hidden from GitHub's rendered view (it is an HTML comment), but it is not
   secret; see [Privacy](#privacy) below.

This is what powers the [dashboard](./dashboard.md): `agent-review-dashboard sync` reads the
footer, falling back to the claim marker, to fill in each review's model, agent, and tool version.
Without `captureMetadata`, the dashboard still works, but those columns show up as unknown, since
there is nothing in the review body to read them from.

:::note[Why a footer, not just the claim marker]
The claim marker is a comment, and `review.complete`/`review.enrich` delete every one of the
claiming agent's own claim-marker comments once they post a review, so a v2 marker's `model` and
`agent` are only visible for as long as the claim is active. The footer instead lives in the review
body itself, which is never deleted, so it is the durable copy the dashboard (or anything else that
reads PR history later) can actually rely on.
:::

## How to enable

Set it in `~/.agent-peer-review/config.json` (see [Files and directories](./files-and-directories.md)
for where that file lives and the other locations it is resolved from):

```json
{ "captureMetadata": true }
```

or for a single invocation, without touching the file:

```bash
AGENT_REVIEW_CAPTURE_METADATA=1 agent-review complete --repo owner/name --pr 42 --event approve --summary "LGTM"
```

Any of `1`, `true`, or `yes` (case-insensitive) turns it on; anything else, or leaving the variable
unset, leaves the config file's value (default `false`) in place.

`captureMetadata` only turns capture on or off; it does not say what to capture. Populate the
fields with either the matching config key or environment variable (the environment variable wins
when both are set):

| Field | Config key | Environment variable | Example |
| --- | --- | --- | --- |
| Model | `model` | `AGENT_REVIEW_MODEL` | `claude-opus-4-8` |
| Agent or host | `agent` | `AGENT_REVIEW_AGENT` | `claude-code` |
| Tool version | `toolVersion` | `AGENT_REVIEW_TOOL_VERSION` | `2.1.0` |

A field left unset on both sides is simply omitted from the footer and the marker; capture never
fails a claim or a completion because a field is missing.

## Privacy

:::caution
The footer and the v2 claim marker are written straight into the review body and comment text,
both of which are **public** on a public repository. Enabling `captureMetadata` makes the model,
agent, and machine name you configure part of the pull request's permanent, public record, not
just the value briefly visible on an active claim marker. Enable it only where that is acceptable,
and avoid putting anything more identifying than you intend into `model`, `agent`, or a machine's
hostname.
:::

`machine` in particular is not something you configure directly: it comes from the reviewing
process's own hostname. If that hostname identifies a person or a piece of infrastructure you would
rather not publish, either rename the host or run the reviewing agent somewhere with a generic one.
