---
title: "ADR 0003: Core library with thin adapters"
sidebar_label: "0003. Core library and thin adapters"
---

## Status

Accepted.

## Context

The same workflow must run identically from a terminal, an MCP host, and pi.dev, without triplicating GitHub logic, and unit tests need to exercise real behavior without hitting the GitHub API.

## Decision

All domain logic, label composition, claim-marker parsing, skill and language loading, and the five review operations, lives in `core`, behind one `GitHubGateway` interface (`core/github.ts`). `OctokitGateway` implements it for production; `FakeGitHubGateway` (`test/fakes/fake-github.ts`) implements it for tests. `core/index.ts` exports the model types, the gateway, and the operations (`createReview`, `listReviews`, `claimReview`, `completeReview`, `enrichReview`, `bootstrap`) as the one public surface. Each adapter, the CLI (`cli/index.ts`), the MCP server (`mcp/server.ts`), and the pi.dev extension (`pi/src/extension.ts`, see [ADR 0006](0006-pi-dev-integration-as-a-pi-package.md)), does nothing but translate its host's calling convention into a call on one of those operations and wrap the result; the MCP and pi adapters both wrap output in the identical `{ content: [{ type: "text", text }] }` shape. Skills and language checklists are loaded inside `core` and served in the composed review task returned by `claim`, so no adapter or host keeps its own copy of review guidance, and the state `core` reads and writes is entirely the GitHub state described in [ADR 0001](0001-github-as-the-source-of-truth.md).

## Consequences

One code path is exercised by all three surfaces, so a fix or a new operation lands everywhere at once. Unit tests run against the fake gateway with no network and no fixtures. Adding a fourth host means writing a thin adapter, not reimplementing claim semantics; the cost is that no adapter can express host-specific behavior without either duplicating logic locally or extending `core` itself.

## Update (2026-08-21)

Two corrections to the decision text above, neither of which changes the decision.

The count was wrong when it was written. "The five review operations" is followed by a list of **six**: `createReview`, `listReviews`, `claimReview`, `completeReview`, `enrichReview`, and `bootstrap`.

`core` now exports **thirteen** operations. Five are Pi-only expedition operations: `stabilize`, `expedite`, `requestPeerReview`, `approveDependencyUpgrade`, and `watchAndReReview`. Two later cross-host operations, `recordSelfReview` and `createFollowUp`, enforce the implementer handoff and single meaningful follow-up issue. All domain logic still lives in `core` behind `GitHubGateway`; the CLI, MCP, and Pi surfaces are adapters.
