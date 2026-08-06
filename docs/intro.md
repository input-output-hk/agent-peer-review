---
slug: /
sidebar_position: 1
---

# Agent Peer Review

<div className="hero-banner">
<p className="hero-tagline">Turn a GitHub pull request into a task your AI agent can claim, review, and complete on its own.</p>
<p>Agent Peer Review is a minimal, asynchronous review workflow for AI agents such as Claude, Codex, and pi.dev, built so GitHub stays the single source of truth. No queue, no database, no scheduler to run.</p>
</div>

## Why it works this way

<div className="feature-grid">
  <div className="feature-card">
    <h3>GitHub-native</h3>
    <p>No external queue or database to run. A single <code>ai-review</code> label, GitHub's own reviewer request, a claim-marker comment, and a native pull request review carry the entire workflow end to end.</p>
  </div>
  <div className="feature-card">
    <h3>CLI and MCP, one core</h3>
    <p>One TypeScript core library drives both a scriptable <code>agent-review</code> CLI and a five-tool MCP server, so the same operations work from a terminal, a script, or an MCP host.</p>
  </div>
  <div className="feature-card">
    <h3>Label-selected skills</h3>
    <p>Attach a skill label such as <code>security</code> or <code>api</code> to a request, and the reviewer agent receives that specialty checklist layered on the default review, composed automatically the moment it claims the pull request. Programming languages need no label at all: the agent detects them from the pull request's changed files and loads the matching checklist on its own.</p>
  </div>
  <div className="feature-card">
    <h3>Zero-config by default</h3>
    <p>Install the package and run <code>labels bootstrap</code> once. Your GitHub login and default repository are auto-detected, so most teams never need to write a config file at all.</p>
  </div>
</div>

## How it works

1. **Request.** An engineer, or another agent, adds the `ai-review` label to a pull request and requests a reviewer through GitHub's own Reviewers field. An optional skill label such as `security` attaches a specialty.
2. **Claim.** The reviewer agent lists its open requests, claims one, and gets back the pull request pinned to a commit SHA plus the fully composed review instructions.
3. **Complete.** The agent submits a native GitHub pull request review at that pinned commit. GitHub clears the request automatically, and the claim marker is deleted.

Continue to [Quick start](./quick-start.md) to install the package and wire it into a host, or read [Lifecycle](./lifecycle.md) for the full state machine behind these three steps.
