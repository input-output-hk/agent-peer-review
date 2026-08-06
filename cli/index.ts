#!/usr/bin/env node
import { hostname } from "node:os";
import { readFileSync } from "node:fs";
import { Command } from "commander";
import {
  loadConfig, OctokitGateway, bootstrap, SKILL_NAMES,
  createReview, listReviews, claimReview, completeReview, enrichReview,
} from "../core/index.js";
import { printJson, printLine } from "./render.js";

const program = new Command();
program.name("agent-review").description("Minimal async PR review over GitHub").version("0.2.0");
program.option("-c, --config <path>", "explicit config file path");

const gh = () => new OctokitGateway();
const cfg = () => loadConfig(program.opts().config);
const repoOf = (o: { repo?: string }): string => {
  const r = o.repo ?? cfg().defaultRepo;
  if (!r) throw new Error("--repo is required (or set defaultRepo in your config)");
  return r;
};

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

const csv = (v?: string): string[] => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
const readMaybeFile = (v: string): string => (v.startsWith("@") ? readFileSync(v.slice(1), "utf8") : v);

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
