---
title: "ADR 0006: pi.dev integration as a Pi Package"
sidebar_label: "0006. pi.dev as a Pi Package"
---

## Status

Accepted.

## Context

pi.dev has its own extension and skill distribution mechanism, a Pi Package, distinct from an MCP server or a CLI binary. Supporting it natively should not fork the review logic, and it should not force `core` to depend on a pi.dev-specific type surface.

## Decision

pi.dev support ships as its own package, `@input-output-hk/agent-review-pi`, under `pi/`, rather than inside the main package. `pi/src/extension.ts` exports `registerTools`, a factory that registers six tools, `review_create`, `review_list`, `review_claim`, `review_complete`, `review_enrich`, and `labels_bootstrap`, with typebox parameter schemas, each `execute` mapping directly onto the matching `core` operation and wrapping the result in the same `{ content: [{ type: "text", text }] }` shape the MCP adapter uses (see [ADR 0003](0003-core-library-with-thin-adapters.md)), plus a default export that is the actual Pi extension entry point. A bundled skill, `pi/skills/agent-review/SKILL.md`, drives the claim-review-complete loop in Pi terms. `pi/package.json` carries `keywords: ["pi-package"]` and a `pi` manifest (`{ extensions, skills }`), and depends on the core package by a caret range kept in lockstep with core on each release, publishable, yet resolvable to the local workspace copy during development. To make that local resolution work, the root `package.json` gained `"workspaces": ["pi", "."]`, listing itself alongside `pi` so `core` is resolvable by package name, plus `main`, `types`, and `exports` fields so that link resolves to something.

## Consequences

pi.dev users get first-class tools and a skill with one `pi install`, and `core` never imports anything pi-specific. CI and the publish workflow both gained a dedicated `pi` job or step that runs `npm run -w pi ...` after the root package builds, since the pi package's dependency on the root package must resolve before it can type-check, test, or build.

## Update (2026-08-21)

`registerTools` now registers **thirteen** tools. The original six review tools remain; five expedition tools move pull requests forward, and `pr_self_review` plus `pr_create_followup` enforce the implementer handoff and one-issue proportionality rule. Each still maps to a core operation and wraps the result in the same `{ content: [{ type: "text", text }] }` shape.

The MCP adapter now registers the original six review/label tools plus cross-host self-review and follow-up, for eight total. The five expedition operations remain Pi-only because the [taskflows](../taskflows.md) that drive them are a pi.dev feature; Pi exposes those five plus the two cross-host author tools under `pr_*`, for thirteen total.
