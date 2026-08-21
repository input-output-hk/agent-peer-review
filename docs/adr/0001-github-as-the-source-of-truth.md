---
title: "ADR 0001: GitHub as the source of truth"
sidebar_label: "0001. GitHub as source of truth"
---

## Status

Accepted.

## Context

The workflow spans agents running on different machines, on Claude, Codex, and pi.dev hosts, with no shared process between them. It has to survive a reviewer crashing mid-review, avoid inventing a queue or database, and stay auditable by a human without a custom dashboard.

## Decision

GitHub itself holds every piece of workflow state, across exactly three states. Requested is the `ai-review` trigger label plus a native requested-reviewer entry, set by `review.create` through GitHub's `requestReviewers` API. Claimed is a structured claim-marker comment, `<!-- agent-review:claim {"v":1,"reviewer":...,"sha":...,"claimedAt":...} -->` (`core/claim-marker.ts`), posted by `review.claim` (`core/operations/claim.ts`); it pins the head SHA at claim time and is the sole record of in-progress work, so a restarted agent re-reads PR comments and resumes its own marker instead of losing or duplicating the claim. Done is a native PR review submitted by `review.complete` (`core/operations/complete.ts`) with `commit_id` set to that pinned SHA; submitting the review natively clears the requested-reviewer entry, so no terminal label or extra call is needed, and the agent then deletes its own marker.

## Consequences

Restart-safe by construction, with no queue or database to keep in sync with reality, and every transition stays visible in the ordinary GitHub PR UI. The cost is bounded by GitHub itself: listing work relies on the search API and its eventual consistency, and claim races are resolved by comparing timestamps and comment ids rather than a true lock (see [ADR 0004](0004-panel-review-concurrent-reviewers.md)).

## Update (2026-08-21)

Two notes on the claim marker, neither of which changes the decision.

**The marker carries a version, and there are two.** `ClaimMarkerSchema` accepts `"v": 1 | 2`, so the example above shows one of two shapes. A v2 marker carries three optional extra fields, `model`, `agent`, and `toolVersion`, plus the reviewing machine, and is written only when the opt-in `captureMetadata` config switch is on; with it off, the v1 marker shown above omits the hostname. Existing v1 and v2 markers that carry `machine` still parse. Every marker of either version parses through the same linear pass. See [Review metadata capture](../metadata-capture.md).

**The pin moves when it falls behind.** As originally written, a restarted agent resumed on whatever commit its own marker named, and nothing ever moved it, so an agent whose run stalled re-claimed a dead commit on every tick and reviewed code that no longer existed. `claimReview` now re-pins its own marker to the current head when the pinned commit is no longer the head: every marker of that login's is deleted and one is posted carrying the new SHA, in that order. The marker format is untouched and `claimedAt` is carried over, so a re-pin cannot reorder the panel and an anchor stays the anchor. Resuming an *unchanged* head is still exactly what it was.
