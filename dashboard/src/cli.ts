#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { OctokitGateway, agentHome, ensureAgentHome } from "@input-output-hk/agent-review";
import { openDb, type DB } from "./db/open.js";
import { sync, type SyncCounts } from "./sync.js";
import type { SyncGateway } from "./sync-gateway.js";

export async function runSync(deps: { gateway: SyncGateway; db: DB }, opts: { repos: string[]; login?: string }): Promise<SyncCounts> {
  const { counts } = await sync(deps.gateway, deps.db, opts.repos, { login: opts.login });
  return counts;
}

// The default lives under the shared agent-peer-review home (see core/paths.ts) so `sync` and a
// future dashboard API server agree on where the database is without either side passing --db.
export function defaultDbPath(): string {
  return path.join(agentHome(), "dashboard.db");
}

export function buildProgram(): Command {
  const program = new Command();
  program.name("agent-review-dashboard").description("Local dashboard for agent PR-review activity");
  program
    .command("sync")
    .description("Pull agent review activity from GitHub into the local SQLite database")
    .requiredOption("-r, --repo <owner/name...>", "one or more repositories to sync")
    .option("-d, --db <path>", "SQLite database file", defaultDbPath())
    .option("-l, --login <login>", "agent login (defaults to the authenticated user)")
    .action(async (o: { repo: string[]; db: string; login?: string }, command: Command) => {
      // better-sqlite3 does not create missing parent directories, so ensure one exists before
      // opening the database: the shared home for the default path, or the specific parent
      // directory the caller pointed --db at.
      if (command.getOptionValueSource("db") === "default") {
        ensureAgentHome();
      } else {
        mkdirSync(path.dirname(o.db), { recursive: true });
      }
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
