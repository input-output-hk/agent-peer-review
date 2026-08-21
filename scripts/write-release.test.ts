import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "write-release.mjs");

function fixture(version = "0.5.0") {
  const root = mkdtempSync(path.join(tmpdir(), "write-release-"));
  mkdirSync(path.join(root, "pi"));
  mkdirSync(path.join(root, "dashboard"));
  mkdirSync(path.join(root, "cli"));
  mkdirSync(path.join(root, "mcp"));
  writeFileSync(path.join(root, "package.json"), `{\n  "name": "core",\n  "version": "${version}"\n}\n`);
  writeFileSync(path.join(root, "pi/package.json"), `{\n  "version": "${version}",\n  "dependencies": { "@input-output-hk/agent-review": "^${version}" }\n}\n`);
  writeFileSync(path.join(root, "dashboard/package.json"), `{\n  "version": "${version}",\n  "dependencies": { "@input-output-hk/agent-review": "^${version}" }\n}\n`);
  writeFileSync(path.join(root, "cli/index.ts"), `program.version("${version}");\n`);
  writeFileSync(path.join(root, "mcp/server.ts"), `new Server({ name: "agent-review", version: "${version}" });\n`);
  writeFileSync(path.join(root, "package-lock.json"), `${JSON.stringify({
    version,
    packages: {
      "": { version },
      dashboard: { version, dependencies: { "@input-output-hk/agent-review": `^${version}` } },
      pi: { version, dependencies: { "@input-output-hk/agent-review": `^${version}` } },
    },
  }, null, 2)}\n`);
  writeFileSync(path.join(root, "CHANGELOG.md"), `# Changelog\n\n## Unreleased\n\n- release note\n\n## ${version}\n\n- old\n`);
  return { root, notes: path.join(root, "notes.md") };
}

function run(root: string, spec: string, notes: string) {
  return spawnSync(process.execPath, [SCRIPT, spec, notes], { cwd: root, encoding: "utf8" });
}

describe("dependency-free release writer", () => {
  it("bumps every published version surface, the lockfile, and the changelog", () => {
    const { root, notes } = fixture();
    const result = run(root, "minor", notes);
    expect(result.status, result.stderr).toBe(0);
    for (const file of ["package.json", "pi/package.json", "dashboard/package.json", "cli/index.ts", "mcp/server.ts", "package-lock.json"]) {
      expect(readFileSync(path.join(root, file), "utf8"), file).toContain("0.6.0");
      expect(readFileSync(path.join(root, file), "utf8"), file).not.toContain("0.5.0");
    }
    expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toContain("## Unreleased\n\n## 0.6.0\n");
    expect(readFileSync(notes, "utf8")).toBe("- release note\n");
  });

  it("supports a greater prerelease and reports it through GITHUB_OUTPUT", () => {
    const { root, notes } = fixture();
    const output = path.join(root, "output");
    const result = spawnSync(process.execPath, [SCRIPT, "0.6.0-rc.1", notes], {
      cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, "utf8")).toBe("version=0.6.0-rc.1\nprerelease=true\n");
  });

  it.each([
    ["0.6.0-rc.1", "patch", "0.6.0"],
    ["0.6.0-rc.1", "minor", "0.6.0"],
    ["2.0.0-rc.1", "major", "2.0.0"],
    ["1.2.3-beta.2", "minor", "1.3.0"],
  ])("matches node-semver promotion: %s + %s -> %s", (current, spec, expected) => {
    const { root, notes } = fixture(current);
    const result = run(root, spec, notes);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(root, "package.json"), "utf8")).toContain(`"version": "${expected}"`);
  });

  it.each(["0.5.0", "0.4.9", "not-a-version", "1.0.0-01", "9007199254740992.0.0"])("rejects unsafe explicit version %s", (version) => {
    const { root, notes } = fixture();
    expect(run(root, version, notes).status).not.toBe(0);
    expect(readFileSync(path.join(root, "package.json"), "utf8")).toContain('"version": "0.5.0"');
  });

  it("imports only Node built-ins so the credentialed job needs no node_modules", () => {
    const source = readFileSync(SCRIPT, "utf8");
    expect(source).not.toMatch(/from\s+["'](?!node:)/);
  });
});
