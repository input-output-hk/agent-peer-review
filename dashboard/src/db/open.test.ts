import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { openDb } from "./open.js";
import { runMigrations, LATEST_VERSION } from "./migrate.js";
import { MIGRATIONS } from "./migrations.js";

function tableNames(db: ReturnType<typeof openDb>): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r: any) => r.name as string);
}

describe("openDb", () => {
  it("creates the full schema and stamps user_version", () => {
    const db = openDb(":memory:");
    expect(tableNames(db)).toEqual([
      "claim", "participant", "pull_request", "repo", "review", "review_note", "sync_run",
    ]);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_VERSION);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("runMigrations is idempotent (second run applies nothing, no throw)", () => {
    const db = openDb(":memory:");
    expect(runMigrations(db)).toBe(LATEST_VERSION);
    expect(runMigrations(db)).toBe(LATEST_VERSION);
  });

  it("upgrades a v1 database to nullable claim machines without losing existing claims", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATIONS[0].sql);
    db.pragma("user_version = 1");
    db.prepare("INSERT INTO repo(owner,name) VALUES('o','r')").run();
    db.prepare(
      "INSERT INTO pull_request(repo_id,number,title,author_login,state,url,head_sha,base_sha,created_at,updated_at) " +
      "VALUES(1,7,'t','a','open','u','h','b','c','u')",
    ).run();
    db.prepare(
      "INSERT INTO claim(pr_id,reviewer_login,machine,sha,claimed_at) VALUES(1,'agent-bot','old-host','h','c')",
    ).run();

    expect(runMigrations(db)).toBe(2);
    expect(db.prepare("SELECT reviewer_login, machine FROM claim").get()).toEqual({
      reviewer_login: "agent-bot",
      machine: "old-host",
    });
    expect(() => db.prepare(
      "INSERT INTO claim(pr_id,reviewer_login,machine,sha,claimed_at) VALUES(1,'private-bot',NULL,'h','c')",
    ).run()).not.toThrow();
  });

  it("enforces the pull_request unique constraint", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO repo(owner,name) VALUES('o','r')").run();
    const ins = db.prepare(
      "INSERT INTO pull_request(repo_id,number,title,author_login,state,url,head_sha,base_sha,created_at,updated_at,merged_at) " +
      "VALUES(1,7,'t','a','open','u','h','b','c','u',NULL)",
    );
    ins.run();
    expect(() => ins.run()).toThrow(/UNIQUE/);
  });
});
