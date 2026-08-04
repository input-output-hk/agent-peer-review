import type Database from "better-sqlite3";
import { MIGRATIONS } from "./migrations.js";

type DB = Database.Database;

export const LATEST_VERSION = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);

/** Apply every migration newer than the DB's user_version, in order, inside one transaction. */
export function runMigrations(db: DB): number {
  const current = db.pragma("user_version", { simple: true }) as number;
  const pending = MIGRATIONS.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  const apply = db.transaction(() => {
    for (const m of pending) {
      db.exec(m.sql);
      // user_version takes an integer literal, not a bound parameter; m.version is a trusted number.
      db.pragma(`user_version = ${m.version}`);
    }
  });
  apply();
  return db.pragma("user_version", { simple: true }) as number;
}
