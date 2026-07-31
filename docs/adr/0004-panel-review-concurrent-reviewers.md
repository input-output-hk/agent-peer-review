---
title: "ADR 0004: Panel review with concurrent reviewers"
sidebar_label: "0004. Panel review"
---

## Status

Accepted.

## Context

A pull request can be requested from more than one reviewer. Treating the first claim as an exclusive lock would starve every reviewer after the first and throw away the value of having several independent opinions.

## Decision

Every requested reviewer's agent claims and reviews the same pull request concurrently. Claim markers are keyed per login (`core/operations/claim.ts`), so `claimReview` never refuses because another login already holds a marker; it only resumes the caller's own prior marker or posts a fresh one. Each agent then reads every active marker and sorts by `(claimedAt, commentId)`; whichever is earliest is the anchor, and every other claimant is an enricher, a role each agent computes identically with no coordination between them. The anchor follows the ordinary path: `completeReview` posts the primary verdict at its pinned SHA. An enricher calls `enrichReview` (`core/operations/enrich.ts`): if a review from another author already exists, it submits exactly one `COMMENT`-type review at that review's `commitId`, carrying an overall verdict plus any net-new findings, then deletes its own marker; otherwise it reports `waiting` within the anchor's time-to-live, or `promote` once that TTL has passed and the caller is the earliest surviving marker, so a stalled anchor cannot block the pull request indefinitely. Enrichers also get the auto-attached `second-opinion` skill (see [ADR 0002](0002-labels-and-native-reviewer-routing.md)), which tells them to confirm or refute findings rather than rubber-stamp them.

## Consequences

N reviewers add independent signal with no claim collisions and no duplicate primary reviews; a single requested reviewer is unaffected, since its own marker is trivially the earliest. The poll-and-back-off loop lives in the CLI verb and orchestration skill, not in `core`, and TTL-based promotion assumes reasonably synchronized clocks across reviewing machines.
