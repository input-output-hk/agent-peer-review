import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeGitHubGateway } from "./fakes/fake-github.js";
import { TRIGGER, SKILL_NAMES } from "../core/labels.js";
import { runInit } from "../cli/init.js";

const makeHome = (): string => mkdtempSync(path.join(tmpdir(), "agent-home-"));

// Captures what the CLI's real deps (fs.readFileSync/writeFileSync, console logger) would
// otherwise do, so runInit can be tested with no TTY, no network, and no real disk writes beyond
// the temp home dir. `reads` doubles as the "what's on disk" map: seed it directly to simulate a
// pre-existing (possibly hand-edited) config.json, and writeFile keeps it in sync so a second
// runInit call against the same deps sees what the first one wrote, like a real filesystem would.
function makeDeps(gateway = new FakeGitHubGateway()) {
  const reads = new Map<string, string>();
  const writes = new Map<string, string>();
  const lines: string[] = [];
  return {
    gateway,
    home: makeHome(),
    reads,
    writes,
    lines,
    readFile: (p: string) => reads.get(p),
    writeFile: (p: string, c: string) => { writes.set(p, c); reads.set(p, c); },
    log: (l: string) => { lines.push(l); },
  };
}

const ALL_LABELS = [TRIGGER, ...SKILL_NAMES];

describe("runInit", () => {
  it("writes config.json with only the provided keys, bootstraps the repo, and returns the summary", async () => {
    const deps = makeDeps();
    const result = await runInit({ repos: ["o/r"], captureMetadata: true, model: "m" }, deps);

    const configPath = path.join(deps.home, "config.json");
    expect(result.configPath).toBe(configPath);
    expect(result.login).toBe("me"); // FakeGitHubGateway's default login

    const written = deps.writes.get(configPath);
    expect(written).toBeDefined();
    expect(JSON.parse(written!)).toEqual({ captureMetadata: true, model: "m" });
    expect(written!.endsWith("\n")).toBe(true); // trailing newline

    expect(result.bootstrapped).toEqual([{ repo: "o/r", created: ALL_LABELS, unchanged: [] }]);
  });

  it("omits keys that were not provided (no undefined/empty keys written)", async () => {
    const deps = makeDeps();
    const result = await runInit({ repos: ["o/r"] }, deps);
    const written = deps.writes.get(result.configPath)!;
    expect(JSON.parse(written)).toEqual({});
  });

  it("bootstraps every repo passed, each with its own summary", async () => {
    const deps = makeDeps();
    const result = await runInit({ repos: ["o/r1", "o/r2"] }, deps);
    expect(result.bootstrapped).toEqual([
      { repo: "o/r1", created: ALL_LABELS, unchanged: [] },
      { repo: "o/r2", created: ALL_LABELS, unchanged: [] },
    ]);
  });

  it("reports unchanged on a repo that was already bootstrapped", async () => {
    const gateway = new FakeGitHubGateway();
    const deps = makeDeps(gateway);
    await runInit({ repos: ["o/r"] }, deps);
    const second = await runInit({ repos: ["o/r"] }, deps);
    expect(second.bootstrapped).toEqual([{ repo: "o/r", created: [], unchanged: ALL_LABELS }]);
  });

  it("does not print anything itself; it only writes the config file and returns the summary", async () => {
    const deps = makeDeps();
    await runInit({ repos: ["o/r"] }, deps);
    expect(deps.lines).toEqual([]);
  });

  it("rejects when the repo is not owner/name shaped", async () => {
    const deps = makeDeps();
    await expect(runInit({ repos: ["not-a-repo"] }, deps)).rejects.toThrow(/owner\/name/);
  });

  it("propagates a token/auth failure from getAuthenticatedLogin without writing anything", async () => {
    const gateway = new FakeGitHubGateway();
    gateway.getAuthenticatedLogin = () => Promise.reject(new Error("No GitHub token: set GITHUB_TOKEN or run `gh auth login`."));
    const deps = makeDeps(gateway);
    await expect(runInit({ repos: ["o/r"] }, deps)).rejects.toThrow(/token/i);
    expect(deps.writes.size).toBe(0);
  });

  it("merges into an existing config.json instead of overwriting it, preserving keys it doesn't touch", async () => {
    const deps = makeDeps();
    const configPath = path.join(deps.home, "config.json");
    deps.reads.set(configPath, JSON.stringify({ defaultRepo: "o/r", skillsDir: "/x", model: "old" }));

    const result = await runInit({ repos: ["o/r2"], captureMetadata: true, model: "new" }, deps);

    const written = JSON.parse(deps.writes.get(configPath)!);
    expect(written).toEqual({ defaultRepo: "o/r", skillsDir: "/x", model: "new", captureMetadata: true });
    expect(result.configPath).toBe(configPath);
  });

  it("rejects and does not overwrite the file when the existing config.json is not valid JSON", async () => {
    const deps = makeDeps();
    const configPath = path.join(deps.home, "config.json");
    deps.reads.set(configPath, "{");

    await expect(runInit({ repos: ["o/r"] }, deps)).rejects.toThrow(/not valid JSON/);
    expect(deps.writes.has(configPath)).toBe(false);
    expect(deps.reads.get(configPath)).toBe("{"); // untouched
  });
});
