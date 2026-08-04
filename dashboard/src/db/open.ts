import Database from "better-sqlite3";
import { runMigrations } from "./migrate.js";

export type DB = Database.Database;

/** Open (or create) the SQLite database at `path` (":memory:" for tests), set pragmas, and migrate. */
export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}
