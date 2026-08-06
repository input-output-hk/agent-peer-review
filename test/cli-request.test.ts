import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `cli/index.ts` calls program.parseAsync() unconditionally at module load, so it cannot be
// imported directly in-process without executing the real CLI against vitest's own argv (and
// possibly process.exit). Running it as a subprocess via tsx is the only safe way to exercise it
// end to end. This covers only the reviewers-empty-everywhere path, which is reached before any
// network call (gh() is never invoked), so it needs no GitHub token and makes no real request.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = path.join(repoRoot, "node_modules", ".bin", "tsx");
const cliEntry = path.join(repoRoot, "cli", "index.ts");

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(tsx, [cliEntry, ...args], { cwd: repoRoot, encoding: "utf8", timeout: 20_000 });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe("cli request: reviewers fallback (subprocess)", () => {
  it("exits 1 with a clear stderr message when reviewers are empty everywhere", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cli-req-"));
    const configPath = path.join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ reviewers: [] }));

    const res = runCli(["--config", configPath, "request", "--repo", "o/r", "--pr", "1"]);

    expect(res.status).toBe(1);
    expect(res.stdout.trim()).toBe(""); // nothing on stdout; createReview is never reached
    expect(res.stderr).toContain('No reviewers: pass --reviewers or set "reviewers" in ~/.agent-peer-review/config.json');
  });

  it("exits 1 the same way when the config file has no reviewers key at all", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cli-req-"));
    const configPath = path.join(dir, "config.json");
    writeFileSync(configPath, "{}");

    const res = runCli(["--config", configPath, "request", "--repo", "o/r", "--pr", "1"]);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("No reviewers");
  });
});
