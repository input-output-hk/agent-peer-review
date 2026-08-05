#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { OctokitGateway, agentHome } from "@input-output-hk/agent-review";
import { openDb, openDbReadonly, type DB } from "./db/open.js";
import { sync, type SyncCounts } from "./sync.js";
import type { SyncGateway } from "./sync-gateway.js";
import { buildServer } from "./server.js";

export async function runSync(deps: { gateway: SyncGateway; db: DB }, opts: { repos: string[]; login?: string }): Promise<SyncCounts> {
  const { counts } = await sync(deps.gateway, deps.db, opts.repos, { login: opts.login });
  return counts;
}

// The default lives under the shared agent-peer-review home (see core/paths.ts) so `sync` and
// `serve` agree on where the database is without either side passing --db.
export function defaultDbPath(): string {
  return path.join(agentHome(), "dashboard.db");
}

/**
 * Open the dashboard database read-only for `serve`. `openDbReadonly`'s `fileMustExist` option
 * throws a raw SqliteError when the file does not exist yet (for example, before `sync` has ever
 * run); this converts that into actionable guidance on stderr instead of letting the stack trace
 * escape, then exits with status 1.
 */
export function openServeDb(dbPath: string): DB {
  try {
    return openDbReadonly(dbPath);
  } catch {
    process.stderr.write(`No database at ${dbPath}. Run 'agent-review-dashboard sync' first.\n`);
    return process.exit(1);
  }
}

// better-sqlite3 does not create missing parent directories, so this must run before openDb for
// both the agentHome()-based default and an explicit --db: either way, the resolved path's parent
// is what needs to exist.
export function ensureDbParent(dbPath: string): void {
  mkdirSync(path.dirname(dbPath), { recursive: true });
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
    .action(async (o: { repo: string[]; db: string; login?: string }) => {
      ensureDbParent(o.db);
      const db = openDb(o.db);
      const counts = await runSync({ gateway: new OctokitGateway(), db }, { repos: o.repo, login: o.login });
      process.stdout.write(`Synced ${counts.pulls} PR(s) across ${counts.repos} repo(s): ${counts.reviews} review(s), ${counts.notes} note(s), ${counts.claims} claim(s).\n`);
    });
  program
    .command("serve")
    .description("Serve the read-only dashboard API and UI on localhost")
    .option("-d, --db <path>", "SQLite database file", defaultDbPath())
    .option("-p, --port <port>", "port", "4319")
    .option("--host <addr>", "bind address", "127.0.0.1")
    .action(async (o: { db: string; port: string; host: string }) => {
      const db = openServeDb(o.db);
      const app = buildServer({ db });
      await app.listen({ host: o.host, port: Number(o.port) });
      process.stdout.write(`Dashboard on http://${o.host}:${o.port}\n`);
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
