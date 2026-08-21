#!/usr/bin/env node
import { hostname } from "node:os";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { Command } from "commander";
import {
  loadConfig, OctokitGateway, bootstrap, SKILL_NAMES, ensureAgentHome, skillsRoot,
  createReview, listReviews, claimReview, completeReview, enrichReview, DEFAULT_CLAIM_TTL_MS,
} from "../core/index.js";
import { printJson, printLine, printErrLine } from "./render.js";
import { runInit, promptForInit, describeInitFailure, parseList } from "./init.js";

const program = new Command();
program.name("agent-review").description("Minimal async PR review over GitHub").version("0.5.0");
program.option("-c, --config <path>", "explicit config file path");

const gh = () => new OctokitGateway();
const cfg = () => loadConfig(program.opts().config);
const repoOf = (o: { repo?: string }): string => {
  const r = o.repo ?? cfg().defaultRepo;
  if (!r) throw new Error("--repo is required (or set defaultRepo in your config)");
  return r;
};
const csv = (v?: string): string[] => (v ? parseList(v) : []);
const readMaybeFile = (v: string): string => (v.startsWith("@") ? readFileSync(v.slice(1), "utf8") : v);

program.command("config").description("Show the resolved machine config").action(() => printJson(cfg()));

program.command("whoami").description("Show the resolved GitHub login").action(async () => {
  printLine(cfg().githubLogin ?? (await gh().getAuthenticatedLogin()));
});

program.command("skills")
  .argument("[action]", "list", "list")
  .description("List available review skills")
  .action(() => printJson([...SKILL_NAMES]));

program.command("labels")
  .argument("<action>", "bootstrap")
  .option("--repo <owner/name>")
  .description("Bootstrap the label profile (ai-review + skills) on a repo")
  .action(async (action: string, opts: { repo?: string }) => {
    if (action !== "bootstrap") throw new Error(`unknown labels action: ${action}`);
    printJson(await bootstrap(gh(), { repo: repoOf(opts) }));
  });

const REPO_HINT = "Pass one or more --repo <owner/name>, or run `agent-review init` interactively from a terminal (without --yes).";

// The interactive questions themselves live in cli/init.ts over an injected `ask`; this only binds
// them to a real terminal.
async function askInteractively(): Promise<Awaited<ReturnType<typeof promptForInit>>> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await promptForInit((question) => rl.question(question));
  } finally {
    rl.close();
  }
}

program.command("init")
  .description("Guided setup: authenticate, write the global config, and bootstrap the ai-review label profile")
  .option("--repo <owner/name...>", "repository to bootstrap (repeatable)")
  .option("--reviewer <login...>", "default reviewer login to request when a create call omits --reviewers (repeatable)")
  .option("--known-agent-login <login...>", "GitHub login the expedition safety gate should treat as an agent rather than a human (repeatable)")
  .option("--capture-metadata", "opt in to durable review metadata capture (model/agent/machine become part of the public review)")
  .option("--model <model>", "model identifier recorded when --capture-metadata is on")
  .option("--agent <agent>", "agent/host identifier recorded when --capture-metadata is on")
  .option("--tool-version <version>", "tool version recorded when --capture-metadata is on")
  .option("--yes", "non-interactive: never prompt; fail with guidance if --repo is missing")
  .action(async (opts: { repo?: string[]; reviewer?: string[]; knownAgentLogin?: string[]; captureMetadata?: boolean; model?: string; agent?: string; toolVersion?: string; yes?: boolean }) => {
    let repos = opts.repo ?? [];
    let captureMetadata = opts.captureMetadata;
    let model = opts.model;
    let agent = opts.agent;
    let reviewers = opts.reviewer;
    let knownAgentLogins = opts.knownAgentLogin;

    if (repos.length === 0) {
      if (opts.yes || !process.stdin.isTTY) {
        printLine(`No --repo provided. ${REPO_HINT}`);
        process.exitCode = 1;
        return;
      }
      const answers = await askInteractively();
      repos = answers.repos;
      if (captureMetadata === undefined) captureMetadata = answers.captureMetadata;
      model = model ?? answers.model;
      agent = agent ?? answers.agent;
      reviewers = reviewers ?? answers.reviewers;
      knownAgentLogins = knownAgentLogins ?? answers.knownAgentLogins;
    }

    if (repos.length === 0) {
      printLine(`No repositories given; nothing to bootstrap. ${REPO_HINT}`);
      process.exitCode = 1;
      return;
    }

    let result;
    try {
      result = await runInit(
        { repos, captureMetadata, model, agent, toolVersion: opts.toolVersion, reviewers, knownAgentLogins },
        {
          gateway: gh(),
          home: ensureAgentHome(),
          readFile: (p) => (existsSync(p) ? readFileSync(p, "utf8") : undefined),
          writeFile: (p, c) => writeFileSync(p, c),
          log: printLine,
        },
      );
    } catch (e) {
      for (const line of describeInitFailure(e)) printLine(line);
      process.exitCode = 1;
      return;
    }

    printLine(`Wrote config to ${result.configPath}`);
    printLine(`Authenticated as ${result.login}`);
    for (const b of result.bootstrapped) {
      printLine(`Bootstrapped ${b.repo}: created [${b.created.join(", ")}], unchanged [${b.unchanged.join(", ")}]`);
    }
    // The three fields that decide whether the next command works. Each is named either way, set or
    // unset, so a successful init cannot hide the one thing still missing.
    printLine(
      result.defaultRepo !== undefined
        ? `Default repo: ${result.defaultRepo}`
        : "Default repo: (none set; every command needs --repo until \"defaultRepo\" names one)",
    );
    printLine(
      result.reviewers.length > 0
        ? `Default reviewers: ${result.reviewers.join(", ")}`
        : "Default reviewers: (none set; `request` needs --reviewers until --reviewer lists your peer agents)",
    );
    printLine(
      result.knownAgentLogins.length > 0
        ? `Known agent logins: ${result.knownAgentLogins.join(", ")}`
        : "Known agent logins: (none set; every reviewer counts as human until --known-agent-login lists your peer agents)",
    );
    printLine("");
    printLine("MCP server config (paste into your host's MCP settings):");
    printJson({ mcpServers: { "agent-review": { command: "agent-review-mcp", env: { GITHUB_TOKEN: "..." } } } });
    printLine("");
    printLine(`Skill: ${path.join(skillsRoot(cfg()), "orchestration.md")}`);
    printLine("Enable it in your host (Claude Code, Codex, pi.dev) so the reviewing agent knows the claim -> review -> complete loop.");
    if (result.expeditionPermissionsWarning) {
      printErrLine("");
      printErrLine("!".repeat(72));
      printErrLine(`WARNING: ${result.expeditionPermissionsWarning}`);
      printErrLine("!".repeat(72));
    }
  });

program.command("request")
  .option("--repo <owner/name>").requiredOption("--pr <n>", "PR number")
  .option("--reviewers <csv>", "comma-separated GitHub logins to request review from (defaults to the \"reviewers\" config field)")
  .option("--skills <csv>", "comma-separated skills", "")
  .option("--note <text>")
  .action(async (o) => {
    const reviewers = o.reviewers ? csv(o.reviewers) : cfg().reviewers;
    if (reviewers.length === 0) {
      printErrLine('No reviewers: pass --reviewers or set "reviewers" in ~/.agent-peer-review/config.json');
      process.exitCode = 1;
      return;
    }
    printJson(await createReview(gh(), { repo: repoOf(o), pr: Number(o.pr), skills: csv(o.skills), reviewers, note: o.note }));
  });

program.command("list")
  .option("--repo <owner/name>")
  .option("--reviewer <login>", "filter by requested login (defaults to your own)")
  .action(async (o) => {
    const login = o.reviewer ?? cfg().githubLogin ?? undefined;
    printJson(await listReviews(gh(), { repo: repoOf(o), login }));
  });

program.command("claim")
  .option("--repo <owner/name>").requiredOption("--pr <n>")
  .action(async (o) => {
    printJson(await claimReview({ gh: gh(), config: cfg(), machine: hostname(), now: new Date().toISOString() }, { repo: repoOf(o), pr: Number(o.pr) }));
  });

program.command("complete")
  .option("--repo <owner/name>").requiredOption("--pr <n>")
  .requiredOption("--event <event>", "approve | request-changes | comment")
  .requiredOption("--summary <text|@file>")
  .option("--comments <@file>", "JSON array of {path,line,body}")
  .action(async (o) => {
    printJson(await completeReview({ gh: gh(), config: cfg() }, {
      repo: repoOf(o), pr: Number(o.pr), event: o.event, summary: readMaybeFile(o.summary),
      comments: o.comments ? JSON.parse(readMaybeFile(o.comments)) : undefined,
    }));
  });

program.command("enrich")
  .option("--repo <owner/name>").requiredOption("--pr <n>")
  .requiredOption("--verdict <agree|disagree|mixed>")
  .requiredOption("--summary <text|@file>")
  .option("--comments <@file>", "JSON array of {path,line,body} new findings")
  .option("--poll <seconds>", "seconds between polls", "5")
  .option("--timeout <seconds>", "seconds before giving up", "1800")
  .action(async (o) => {
    const enrichment = { overallVerdict: o.verdict, summary: readMaybeFile(o.summary), newFindings: o.comments ? JSON.parse(readMaybeFile(o.comments)) : undefined };
    const repo = repoOf(o), pr = Number(o.pr), waitMs = Number(o.timeout) * 1000;
    const deadline = Date.now() + waitMs;
    const ghi = gh(), config = cfg();
    for (;;) {
      const res = await enrichReview(
        { gh: ghi, config, ttlMs: DEFAULT_CLAIM_TTL_MS, nowMs: Date.now() },
        { repo, pr, ...enrichment },
      );
      if (res.status === "enriched") { printJson(res); return; }
      if (res.status === "promote") {
        const event = o.verdict === "agree" ? "approve" : o.verdict === "disagree" ? "request-changes" : "comment";
        printJson(await completeReview({ gh: ghi, config }, { repo, pr, event, summary: enrichment.summary, comments: enrichment.newFindings }));
        return;
      }
      if (Date.now() >= deadline) { printLine("Timed out waiting for the primary review."); process.exitCode = 1; return; }
      await new Promise((r) => setTimeout(r, Number(o.poll) * 1000));
    }
  });

program.command("serve").description("Run the MCP server over stdio").action(async () => {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { buildServer } = await import("../mcp/server.js");
  await buildServer().connect(new StdioServerTransport());
});

program.parseAsync().catch((e) => { printLine(`Error: ${(e as Error).message}`); process.exitCode = 1; });
