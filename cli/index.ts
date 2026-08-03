#!/usr/bin/env node
import { hostname } from "node:os";
import { Command } from "commander";
import {
  loadConfig, OctokitGateway, bootstrap, SKILL_NAMES,
  createReview, listReviews, claimReview, completeReview, runEnrichLoop,
} from "../core/index.js";
import { printJson, printLine } from "./render.js";
import { csv, readMaybeFile, repoOf } from "./util.js";

const program = new Command();
program.name("agent-review").description("Minimal async PR review over GitHub").version("0.1.0");
program.option("-c, --config <path>", "explicit config file path");

const gh = () => new OctokitGateway();
const cfg = () => loadConfig(program.opts().config);

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
  .description("Bootstrap the label profile (agent + skills) on a repo")
  .action(async (action: string, opts: { repo?: string }) => {
    if (action !== "bootstrap") throw new Error(`unknown labels action: ${action}`);
    printJson(await bootstrap(gh(), { repo: repoOf(opts, cfg().defaultRepo) }));
  });

program.command("request")
  .option("--repo <owner/name>").requiredOption("--pr <n>", "PR number")
  .requiredOption("--reviewers <csv>", "comma-separated GitHub logins to request review from")
  .option("--skills <csv>", "comma-separated skills", "")
  .option("--note <text>")
  .action(async (o) => {
    printJson(await createReview(gh(), { repo: repoOf(o, cfg().defaultRepo), pr: Number(o.pr), skills: csv(o.skills), reviewers: csv(o.reviewers), note: o.note }));
  });

program.command("list")
  .option("--repo <owner/name>")
  .option("--reviewer <login>", "filter by requested login (defaults to your own)")
  .action(async (o) => {
    const login = o.reviewer ?? cfg().githubLogin ?? undefined;
    printJson(await listReviews(gh(), { repo: repoOf(o, cfg().defaultRepo), login }));
  });

program.command("claim")
  .option("--repo <owner/name>").requiredOption("--pr <n>")
  .action(async (o) => {
    printJson(await claimReview({ gh: gh(), config: cfg(), machine: hostname(), now: new Date().toISOString() }, { repo: repoOf(o, cfg().defaultRepo), pr: Number(o.pr) }));
  });

program.command("complete")
  .option("--repo <owner/name>").requiredOption("--pr <n>")
  .requiredOption("--event <event>", "approve | request-changes | comment")
  .requiredOption("--summary <text|@file>")
  .option("--comments <@file>", "JSON array of {path,line,body}")
  .action(async (o) => {
    printJson(await completeReview({ gh: gh(), config: cfg() }, {
      repo: repoOf(o, cfg().defaultRepo), pr: Number(o.pr), event: o.event, summary: readMaybeFile(o.summary),
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
    const repo = repoOf(o, cfg().defaultRepo), pr = Number(o.pr), ttlMs = Number(o.timeout) * 1000;
    const res = await runEnrichLoop(
      { gh: gh(), config: cfg(), ttlMs, now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
      { repo, pr, ...enrichment },
      { pollMs: Number(o.poll) * 1000, deadlineMs: Date.now() + ttlMs },
    );
    if (res.outcome === "timeout") { printLine("Timed out waiting for the primary review."); process.exitCode = 1; return; }
    printJson(res.result ?? { outcome: res.outcome });
  });

program.command("serve").description("Run the MCP server over stdio").action(async () => {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { buildServer } = await import("../mcp/server.js");
  await buildServer().connect(new StdioServerTransport());
});

program.parseAsync().catch((e) => { printLine(`Error: ${(e as Error).message}`); process.exitCode = 1; });
