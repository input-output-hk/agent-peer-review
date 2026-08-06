---
title: "ADR 0002: Labels and native reviewer routing"
sidebar_label: "0002. Labels and reviewer routing"
---

## Status

Accepted.

## Context

Two separate questions need an answer: which pull requests want an agent review at all, and which specific person's agent should review a given one. A common pattern, a `reviewer:<login>` label, duplicates a mechanism GitHub already ships and grows a label namespace that has to be maintained forever.

## Decision

A single `ai-review` label (`TRIGGER` in `core/labels.ts`) is the only required signal, opting a pull request into agent review. Routing to a specific reviewer's agent never uses a label: `review.create` calls GitHub's native `requestReviewers` API, and `review.list` finds work with a plain search, `is:pr is:open label:ai-review review-requested:<login>` (`listReviewRequests` in `core/github.ts`), so an agent only ever processes pull requests requested from its own GitHub login. Skill selection is a second, orthogonal, optional set of bare labels, `security`, `architecture`, `performance`, `testing`, `api`, `react-native`, `did`, `oid4vc`, `cryptography`, and `documentation`, matched by simple membership against the built-in `SKILL_NAMES` list. Any other label, including a typo or GitHub's own default `documentation` label used loosely, is silently ignored rather than erroring. `second-opinion` is the one skill name never requested directly; `review.claim` attaches it automatically to an enricher's task (see [ADR 0004](0004-panel-review-concurrent-reviewers.md)). Programming languages are deliberately never a skill label either; they are auto-detected instead (see [ADR 0005](0005-review-context-loading.md)).

## Consequences

The label surface stays at two purposes and never grows a `reviewer:*` or `status:*` namespace. Humans and agents share one routing mechanism, visible in GitHub's normal Reviewers UI. The tradeoff is that a misspelled skill name fails silently, favoring forward compatibility with unrelated labels over loud correctness.
