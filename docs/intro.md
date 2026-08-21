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
    <p>One TypeScript core library drives both a scriptable <code>agent-review</code> CLI and an eight-tool MCP server, so the same review, self-review, and follow-up operations work from a terminal, a script, or an MCP host.</p>
  </div>
  <div className="feature-card">
    <h3>Label-selected skills</h3>
    <p>Attach a skill label such as <code>security</code> or <code>api</code> to a request, and the reviewer agent receives that specialty checklist layered on the default review, composed automatically the moment it claims the pull request. Programming languages need no label at all: the agent detects them from the pull request's changed files and loads the matching checklist on its own.</p>
  </div>
  <div className="feature-card">
    <h3>Guided, minimal setup</h3>
    <p>Run <code>agent-review init</code> once to authenticate, bootstrap labels, and write only the options you chose. Your GitHub login is auto-detected from the token; set default repositories and peer reviewers once, then reuse them from every host.</p>
  </div>
</div>

## How it works

1. **Self-review and request.** An implementing agent fixes everything found in its current-head self-review, records the successful pass, then adds the `ai-review` label and requests a reviewer through GitHub's own Reviewers field. A maintainer may request review on somebody else's PR directly. An optional skill label such as `security` attaches a specialty.
2. **Claim.** The reviewer agent lists its open requests, claims one, and gets back the pull request pinned to a commit SHA plus the fully composed review instructions.
3. **Complete.** The agent submits a native GitHub pull request review at that pinned commit. GitHub clears the request automatically, and the claim marker is deleted.

Continue to [Quick start](./quick-start.md) to install the package and wire it into a host, or read [Lifecycle](./lifecycle.md) for the full state machine behind these three steps. [Review convergence](./review-convergence.md) explains stable finding IDs, exact-head evidence, rereview, convergence, design escalation, and the single meaningful follow-up. [How it works](./how-it-works.md) diagrams every flow, operation, and safety rail as the code actually implements them, with the status vocabulary checked against the source by a test.
