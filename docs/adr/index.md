---
title: "Architecture Decisions"
sidebar_label: "Overview"
---

These records capture the load-bearing decisions behind the agent peer-review workflow: why GitHub itself is the datastore, how labels and native reviewer routing divide responsibility, why the codebase is one core library behind thin adapters, how concurrent panel review avoids collisions, how review context gets assembled and bounded, and how pi.dev integration ships as its own package. Each one explains what was decided and why, grounded in the code that actually shipped, and together they supersede the design specs that shaped the project during its construction.

- [ADR 0001: GitHub as the source of truth](0001-github-as-the-source-of-truth.md)
- [ADR 0002: Labels and native reviewer routing](0002-labels-and-native-reviewer-routing.md)
- [ADR 0003: Core library with thin adapters](0003-core-library-with-thin-adapters.md)
- [ADR 0004: Panel review with concurrent reviewers](0004-panel-review-concurrent-reviewers.md)
- [ADR 0005: Review context loading](0005-review-context-loading.md)
- [ADR 0006: pi.dev integration as a Pi Package](0006-pi-dev-integration-as-a-pi-package.md)
