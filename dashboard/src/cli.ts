#!/usr/bin/env node
import { Command } from "commander";
import { OctokitGateway } from "@input-output-hk/agent-review";
import { openDb, type DB } from "./db/open.js";
import { sync, type SyncCounts } from "./sync.js";
import type { SyncGateway } from "./sync-gateway.js";

export async function runSync(deps: { gateway: SyncGateway; db: DB }, opts: { repos: string[]; login?: string }): Promise<SyncCounts> {
  const { counts } = await sync(deps.gateway, deps.db, opts.repos, { login: opts.login });
  return counts;
}

export function buildProgram(): Command {
  const program = new Command();
  program.name("agent-review-dashboard").description("Local dashboard for agent PR-review activity");
  program
    .command("sync")
    .description("Pull agent review activity from GitHub into the local SQLite database")
    .requiredOption("-r, --repo <owner/name...>", "one or more repositories to sync")
    .option("-d, --db <path>", "SQLite database file", "dashboard.db")
    .option("-l, --login <login>", "agent login (defaults to the authenticated user)")
    .action(async (o: { repo: string[]; db: string; login?: string }) => {
      const db = openDb(o.db);
      const counts = await runSync({ gateway: new OctokitGateway(), db }, { repos: o.repo, login: o.login });
      process.stdout.write(`Synced ${counts.pulls} PR(s) across ${counts.repos} repo(s): ${counts.reviews} review(s), ${counts.notes} note(s), ${counts.claims} claim(s).\n`);
    });
  return program;
}

// Run only when invoked as the bin entry, not when imported by tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  buildProgram().parseAsync(process.argv).catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
