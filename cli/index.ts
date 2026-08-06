#!/usr/bin/env node
import { hostname } from "node:os";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { Command } from "commander";
import {
  loadConfig, OctokitGateway, bootstrap, SKILL_NAMES, ensureAgentHome, skillsRoot,
  createReview, listReviews, claimReview, completeReview, enrichReview,
} from "../core/index.js";
import { printJson, printLine } from "./render.js";
import { runInit } from "./init.js";

const program = new Command();
program.name("agent-review").description("Minimal async PR review over GitHub").version("0.3.0");
program.option("-c, --config <path>", "explicit config file path");

const gh = () => new OctokitGateway();
const cfg = () => loadConfig(program.opts().config);
const repoOf = (o: { repo?: string }): string => {
  const r = o.repo ?? cfg().defaultRepo;
  if (!r) throw new Error("--repo is required (or set defaultRepo in your config)");
  return r;
};
const csv = (v?: string): string[] => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
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

function isAuthError(e: unknown): boolean {
  const err = e as { status?: number; message?: string };
  if (err?.status === 401) return true;
  return /token|credentials|authenticat/i.test(err?.message ?? "");
}

async function promptForInit(): Promise<{ repos: string[]; captureMetadata: boolean; model?: string; agent?: string }> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const repoAnswer = await rl.question("Repositories to bootstrap (owner/name, comma-separated): ");
    const repos = csv(repoAnswer);
    const captureAnswer = await rl.question(
      "Enable review metadata capture? This writes model/agent/machine into the public review (y/N): ",
    );
    const captureMetadata = ["y", "yes"].includes(captureAnswer.trim().toLowerCase());
    let model: string | undefined;
    let agent: string | undefined;
    if (captureMetadata) {
      model = (await rl.question("Model identifier (optional, press enter to skip): ")).trim() || undefined;
      agent = (await rl.question("Agent/host identifier (optional, press enter to skip): ")).trim() || undefined;
    }
    return { repos, captureMetadata, model, agent };
  } finally {
    rl.close();
  }
}

program.command("init")
  .description("Guided setup: authenticate, write the global config, and bootstrap the ai-review label profile")
  .option("--repo <owner/name...>", "repository to bootstrap (repeatable)")
  .option("--capture-metadata", "opt in to durable review metadata capture (model/agent/machine become part of the public review)")
  .option("--model <model>", "model identifier recorded when --capture-metadata is on")
  .option("--agent <agent>", "agent/host identifier recorded when --capture-metadata is on")
  .option("--tool-version <version>", "tool version recorded when --capture-metadata is on")
  .option("--yes", "non-interactive: never prompt; fail with guidance if --repo is missing")
  .action(async (opts: { repo?: string[]; captureMetadata?: boolean; model?: string; agent?: string; toolVersion?: string; yes?: boolean }) => {
    let repos = opts.repo ?? [];
    let captureMetadata = opts.captureMetadata;
    let model = opts.model;
    let agent = opts.agent;

    if (repos.length === 0) {
      if (opts.yes || !process.stdin.isTTY) {
        printLine(`No --repo provided. ${REPO_HINT}`);
        process.exitCode = 1;
        return;
      }
      const answers = await promptForInit();
      repos = answers.repos;
      if (captureMetadata === undefined) captureMetadata = answers.captureMetadata;
      model = model ?? answers.model;
      agent = agent ?? answers.agent;
    }

    if (repos.length === 0) {
      printLine(`No repositories given; nothing to bootstrap. ${REPO_HINT}`);
      process.exitCode = 1;
      return;
    }

    let result;
    try {
      result = await runInit(
        { repos, captureMetadata, model, agent, toolVersion: opts.toolVersion },
        {
          gateway: gh(),
          home: ensureAgentHome(),
          readFile: (p) => (existsSync(p) ? readFileSync(p, "utf8") : undefined),
          writeFile: (p, c) => writeFileSync(p, c),
          log: printLine,
        },
      );
    } catch (e) {
      if (isAuthError(e)) printLine("Could not authenticate to GitHub. Set GITHUB_TOKEN or run `gh auth login`.");
      else printLine(`Error: ${(e as Error).message}`);
      process.exitCode = 1;
      return;
    }

    printLine(`Wrote config to ${result.configPath}`);
    printLine(`Authenticated as ${result.login}`);
    for (const b of result.bootstrapped) {
      printLine(`Bootstrapped ${b.repo}: created [${b.created.join(", ")}], unchanged [${b.unchanged.join(", ")}]`);
    }
    printLine("");
    printLine("MCP server config (paste into your host's MCP settings):");
    printJson({ mcpServers: { "agent-review": { command: "agent-review-mcp", env: { GITHUB_TOKEN: "..." } } } });
    printLine("");
    printLine(`Skill: ${path.join(skillsRoot(cfg()), "orchestration.md")}`);
    printLine("Enable it in your host (Claude Code, Codex, pi.dev) so the reviewing agent knows the claim -> review -> complete loop.");
  });

program.command("request")
  .option("--repo <owner/name>").requiredOption("--pr <n>", "PR number")
  .requiredOption("--reviewers <csv>", "comma-separated GitHub logins to request review from")
  .option("--skills <csv>", "comma-separated skills", "")
  .option("--note <text>")
  .action(async (o) => {
    printJson(await createReview(gh(), { repo: repoOf(o), pr: Number(o.pr), skills: csv(o.skills), reviewers: csv(o.reviewers), note: o.note }));
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
    const repo = repoOf(o), pr = Number(o.pr), ttlMs = Number(o.timeout) * 1000;
    const deadline = Date.now() + ttlMs;
    const ghi = gh(), config = cfg();
    for (;;) {
      const res = await enrichReview({ gh: ghi, config, ttlMs, nowMs: Date.now() }, { repo, pr, ...enrichment });
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
