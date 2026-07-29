#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig, OctokitGateway, bootstrap, SKILL_NAMES } from "../core/index.js";
import { printJson, printLine } from "./render.js";

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
  .requiredOption("--repo <owner/name>")
  .description("Bootstrap the label profile (agent + skills) on a repo")
  .action(async (action: string, opts: { repo: string }) => {
    if (action !== "bootstrap") throw new Error(`unknown labels action: ${action}`);
    printJson(await bootstrap(gh(), { repo: opts.repo }));
  });

program.parseAsync().catch((e) => { printLine(`Error: ${(e as Error).message}`); process.exitCode = 1; });
