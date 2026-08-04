import { describe, it, expect } from "vitest";
import { openDb } from "./open.js";
import { runMigrations, LATEST_VERSION } from "./migrate.js";

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
