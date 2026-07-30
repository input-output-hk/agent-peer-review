# Review lifecycle

```mermaid
sequenceDiagram
  participant R as Requester
  participant GH as GitHub (PR)
  participant A as Reviewer agent
  R->>GH: add `agent` label · request review from yshyn-iohk
  A->>GH: list → label:agent review-requested:me
  A->>GH: claim → pin head SHA · post claim marker
  GH-->>A: composed task (PR + pinned SHA + skill contents)
  A->>A: checkout SHA · run default/specialty review
  A->>GH: complete → submit PR review @ pinned SHA (clears request) · delete marker
```

Every review is pinned to the SHA captured at claim time. If you restart, re-claim: your existing claim resumes on the same SHA. Submitting the review clears GitHub's request, so the PR leaves the queue automatically.
