import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Same subprocess approach, and for the same reason, as test/cli-request.test.ts: `cli/index.ts`
// calls program.parseAsync() at module load, so it cannot be imported in-process. Every case here
// stops inside loadConfig, before the CLI builds a gateway, so no token and no network are needed.
// `init` itself is covered at the runInit level (test/init.test.ts), which needs neither.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = path.join(repoRoot, "node_modules", ".bin", "tsx");
const cliEntry = path.join(repoRoot, "cli", "index.ts");

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(tsx, [cliEntry, ...args], { cwd: repoRoot, encoding: "utf8", timeout: 20_000 });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function writeConfig(config: unknown): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "cli-init-")), "config.json");
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  return file;
}

describe("cli config: the file init writes (subprocess)", () => {
  it("resolves defaultRepo and githubLogin, which is what lets the next command omit --repo", () => {
    // Byte for byte what runInit writes for `init --repo o/n --yes` (see test/init.test.ts).
    const configPath = writeConfig({ githubLogin: "me", defaultRepo: "o/n" });

    const res = runCli(["--config", configPath, "config"]);

    expect(res.status).toBe(0);
    const resolved = JSON.parse(res.stdout);
    expect(resolved.defaultRepo).toBe("o/n"); // repoOf() reads this when --repo is absent
    expect(resolved.githubLogin).toBe("me");
  });
});

describe("cli config: an unknown key (subprocess)", () => {
  it("exits 1 naming the key and the field it was meant to be, not a zod dump", () => {
    const configPath = writeConfig({ knownAgentLogin: ["peer-bot"] });

    const res = runCli(["--config", configPath, "config"]);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain('"knownAgentLogin": did you mean "knownAgentLogins"?');
    expect(res.stdout).toContain(configPath); // which file to go and fix
    expect(res.stdout).not.toContain("unrecognized_keys"); // zod's own wall, replaced
  });

  it("no longer loads such a config as all defaults with exit 0", () => {
    // The whole of the reported symptom: three misspelled keys, and the tool reported success.
    const configPath = writeConfig({ knownAgentLogin: ["peer-bot"], reviewer: ["alice"], defaultRepoo: "a/b" });

    const res = runCli(["--config", configPath, "config"]);

    expect(res.status).toBe(1);
    for (const key of ["knownAgentLogin", "reviewer", "defaultRepoo"]) expect(res.stdout).toContain(key);
  });
});
