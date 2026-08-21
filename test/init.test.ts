import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeGitHubGateway } from "./fakes/fake-github.js";
import { TRIGGER, SKILL_NAMES } from "../core/labels.js";
import { loadConfig } from "../core/config.js";
import { UNREADABLE_CHECKS } from "../core/github.js";
import { runInit, promptForInit, describeInitFailure, BootstrapFailure } from "../cli/init.js";

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
  it("writes config.json with the provided keys, bootstraps the repo, and returns the summary", async () => {
    const deps = makeDeps();
    const result = await runInit({ repos: ["o/r"], captureMetadata: true, model: "m" }, deps);

    const configPath = path.join(deps.home, "config.json");
    expect(result.configPath).toBe(configPath);
    expect(result.login).toBe("me"); // FakeGitHubGateway's default login

    const written = deps.writes.get(configPath);
    expect(written).toBeDefined();
    expect(JSON.parse(written!)).toEqual({ captureMetadata: true, model: "m", githubLogin: "me", defaultRepo: "o/r" });
    expect(written!.endsWith("\n")).toBe(true); // trailing newline

    expect(result.bootstrapped).toEqual([{ repo: "o/r", created: ALL_LABELS, unchanged: [] }]);
  });

  it("omits keys that were not provided (no undefined/empty keys written)", async () => {
    const deps = makeDeps();
    const result = await runInit({ repos: ["o/r"] }, deps);
    const written = deps.writes.get(result.configPath)!;
    // Only the two init resolves for itself; nothing it was not given.
    expect(JSON.parse(written)).toEqual({ githubLogin: "me", defaultRepo: "o/r" });
  });

  it("writes reviewers to config.json when --reviewer is passed, and names them in the result", async () => {
    const deps = makeDeps();
    const result = await runInit({ repos: ["o/r"], reviewers: ["patextreme", "yshyn-iohk"] }, deps);
    const written = deps.writes.get(result.configPath)!;
    expect(JSON.parse(written)).toMatchObject({ reviewers: ["patextreme", "yshyn-iohk"] });
    expect(result.reviewers).toEqual(["patextreme", "yshyn-iohk"]);
  });

  it("writes knownAgentLogins to config.json when --known-agent-login is passed, and names it in the result", async () => {
    const deps = makeDeps();
    const result = await runInit({ repos: ["o/r"], knownAgentLogins: ["peer-bot", "yshyn-iohk"] }, deps);
    const written = deps.writes.get(result.configPath)!;
    expect(JSON.parse(written)).toMatchObject({ knownAgentLogins: ["peer-bot", "yshyn-iohk"] });
    expect(result.knownAgentLogins).toEqual(["peer-bot", "yshyn-iohk"]);
  });

  // Issue #67 item 1: `init --repo o/n --yes` used to write `{}`, so the very next command answered
  // "--repo is required (or set defaultRepo in your config)" after a setup that reported success.
  describe("the config it writes is one the next command can use (issue #67)", () => {
    it("records defaultRepo and githubLogin, and loadConfig resolves both from the file on disk", async () => {
      const deps = makeDeps();
      const result = await runInit({ repos: ["o/n"] }, deps);

      writeFileSync(result.configPath, deps.writes.get(result.configPath)!);
      const cfg = loadConfig(result.configPath);
      expect(cfg.defaultRepo).toBe("o/n"); // what repoOf() falls back to, so `list` needs no --repo
      expect(cfg.githubLogin).toBe("me"); // what `list` filters by and `whoami` prints
    });

    it("reports both in the result so the CLI can name them in the printed summary", async () => {
      const deps = makeDeps();
      const result = await runInit({ repos: ["o/n"] }, deps);
      expect(result.defaultRepo).toBe("o/n");
      expect(result.login).toBe("me");
    });

    it("does not elect a defaultRepo when several repos were passed", async () => {
      const deps = makeDeps();
      const result = await runInit({ repos: ["o/r1", "o/r2"] }, deps);
      const written = JSON.parse(deps.writes.get(result.configPath)!);
      expect(written.defaultRepo).toBeUndefined(); // no basis to pick one; guessing would be worse
      expect(written.githubLogin).toBe("me"); // the login is not in doubt either way
      expect(result.defaultRepo).toBeUndefined();
    });

    it("leaves an existing defaultRepo alone, even when a single different --repo is passed", async () => {
      const deps = makeDeps();
      const configPath = path.join(deps.home, "config.json");
      deps.reads.set(configPath, JSON.stringify({ defaultRepo: "o/chosen" }));
      const result = await runInit({ repos: ["o/other"] }, deps);
      expect(JSON.parse(deps.writes.get(configPath)!).defaultRepo).toBe("o/chosen");
      expect(result.defaultRepo).toBe("o/chosen");
    });

    it("updates githubLogin when the token now belongs to someone else", async () => {
      const gateway = new FakeGitHubGateway();
      const deps = makeDeps(gateway);
      await runInit({ repos: ["o/r"] }, deps);
      gateway.login = "someone-else"; // a rotated token: the recorded login has to follow
      const second = await runInit({ repos: ["o/r"] }, deps);
      expect(JSON.parse(deps.writes.get(second.configPath)!).githubLogin).toBe("someone-else");
    });
  });

  it("reports the knownAgentLogins already on record when a later call does not pass any", async () => {
    const deps = makeDeps();
    await runInit({ repos: ["o/r"], knownAgentLogins: ["peer-bot"] }, deps);
    const second = await runInit({ repos: ["o/r"] }, deps);
    expect(second.knownAgentLogins).toEqual(["peer-bot"]); // carried over, not cleared
  });

  it("reports the reviewers already on record when a later call does not pass any", async () => {
    const deps = makeDeps();
    await runInit({ repos: ["o/r"], reviewers: ["patextreme"] }, deps);
    const second = await runInit({ repos: ["o/r"] }, deps);
    expect(second.reviewers).toEqual(["patextreme"]); // carried over, not cleared
  });

  it("reports no reviewers and no knownAgentLogins when neither was ever set", async () => {
    const deps = makeDeps();
    const result = await runInit({ repos: ["o/r"] }, deps);
    expect(result.reviewers).toEqual([]);
    expect(result.knownAgentLogins).toEqual([]);
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
    expect(written).toEqual({ defaultRepo: "o/r", skillsDir: "/x", model: "new", captureMetadata: true, githubLogin: "me" });
    expect(result.configPath).toBe(configPath);
  });

  it("makes one listLabels round trip per repo, not one per label", async () => {
    const gateway = new FakeGitHubGateway();
    const deps = makeDeps(gateway);
    await runInit({ repos: ["o/r1", "o/r2"] }, deps);
    // Twelve labels per repo, and ensureLabel lists for itself when nobody hands it the list. The
    // first command a new user runs paid that twelve times over before issue #67 item 6.
    expect(gateway.listLabelsCalls).toEqual(["o/r1", "o/r2"]);
  });

  it("rejects and does not overwrite the file when the existing config.json is not valid JSON", async () => {
    const deps = makeDeps();
    const configPath = path.join(deps.home, "config.json");
    deps.reads.set(configPath, "{");

    await expect(runInit({ repos: ["o/r"] }, deps)).rejects.toThrow(/not valid JSON/);
    expect(deps.writes.has(configPath)).toBe(false);
    expect(deps.reads.get(configPath)).toBe("{"); // untouched
  });

  it("rejects an unknown existing key before writing the file or bootstrapping labels", async () => {
    const deps = makeDeps();
    const configPath = path.join(deps.home, "config.json");
    deps.reads.set(configPath, JSON.stringify({ runChecks: false }));

    await expect(runInit({ repos: ["o/r"] }, deps)).rejects.toThrow(/"runChecks": removed with issue #55/);
    expect(deps.writes.has(configPath)).toBe(false);
    expect(deps.gateway.listLabelsCalls).toEqual([]);
  });

  it("rejects a wrong existing value type before writing or bootstrapping", async () => {
    const deps = makeDeps();
    const configPath = path.join(deps.home, "config.json");
    deps.reads.set(configPath, JSON.stringify({ reviewers: "peer-bot" }));

    await expect(runInit({ repos: ["o/r"] }, deps)).rejects.toThrow();
    expect(deps.writes.has(configPath)).toBe(false);
    expect(deps.gateway.listLabelsCalls).toEqual([]);
  });

  describe("expedition permission preflight (issues #54 and #70)", () => {
    it("warns when the gateway cannot read Dependabot alerts (its null sentinel)", async () => {
      const gateway = new FakeGitHubGateway();
      gateway.setAlertCount("o/r", null); // mirrors a 403/404 from GitHub: no access
      const deps = makeDeps(gateway);
      const result = await runInit({ repos: ["o/r"] }, deps);
      expect(result.expeditionPermissionsWarning).toBeDefined();
      expect(result.expeditionPermissionsWarning).toContain("Dependabot alerts");
      expect(result.expeditionPermissionsWarning).toContain("autonomy=auto");
    });

    it("does not warn when the gateway can read Dependabot alerts, even with alerts open", async () => {
      const gateway = new FakeGitHubGateway();
      gateway.setAlertCount("o/r", 3);
      const deps = makeDeps(gateway);
      const result = await runInit({ repos: ["o/r"] }, deps);
      expect(result.expeditionPermissionsWarning).toBeUndefined();
    });

    it("does not warn when every permission probe is explicitly readable", async () => {
      const gateway = new FakeGitHubGateway();
      gateway.setAlertCount("o/r", 0);
      const deps = makeDeps(gateway);
      const result = await runInit({ repos: ["o/r"] }, deps);
      expect(result.expeditionPermissionsWarning).toBeUndefined();
    });

    it("is best-effort: a thrown error from the probe still warns but never fails init", async () => {
      const gateway = new FakeGitHubGateway();
      gateway.listOpenSecurityAlertCount = () => Promise.reject(new Error("network blip"));
      const deps = makeDeps(gateway);
      const result = await runInit({ repos: ["o/r"] }, deps); // must not reject
      expect(result.expeditionPermissionsWarning).toBeDefined();
      expect(result.configPath).toBeDefined(); // the rest of init still completed
    });

    it("checks only the first repo, not every repo passed", async () => {
      const gateway = new FakeGitHubGateway();
      gateway.setAlertCount("o/r1", 0);
      gateway.setAlertCount("o/r2", null); // would warn if this one were checked instead
      const deps = makeDeps(gateway);
      const result = await runInit({ repos: ["o/r1", "o/r2"] }, deps);
      expect(result.expeditionPermissionsWarning).toBeUndefined();
    });

    it("warns when checks or commit statuses cannot be read", async () => {
      const gateway = new FakeGitHubGateway();
      gateway.getChecks = async () => [{ name: UNREADABLE_CHECKS, status: "failure" }];
      const result = await runInit({ repos: ["o/r"] }, makeDeps(gateway));
      expect(result.expeditionPermissionsWarning).toContain("Checks: read");
      expect(result.expeditionPermissionsWarning).toContain("Commit statuses: read");
    });

    it("warns when branch protection cannot be read", async () => {
      const gateway = new FakeGitHubGateway();
      gateway.setBranchProtection("o/r", "main", "unknown");
      const result = await runInit({ repos: ["o/r"] }, makeDeps(gateway));
      expect(result.expeditionPermissionsWarning).toContain("Administration: read");
    });
  });

  // Issue #67 item 4: the likeliest permission failure, a token without Issues write, used to
  // surface as a bare "Resource not accessible by integration" naming no repository, no permission,
  // and no hint that init had already written a config file.
  describe("a bootstrap failure (issue #67)", () => {
    const forbidden = (message = "Resource not accessible by integration") =>
      Object.assign(new Error(message), { status: 403 });

    function gatewayRefusing(error: Error, onRepo = "o/r"): FakeGitHubGateway {
      const gateway = new FakeGitHubGateway();
      const real = gateway.ensureLabel.bind(gateway);
      gateway.ensureLabel = (repo, label, known) => (repo === onRepo ? Promise.reject(error) : real(repo, label, known));
      return gateway;
    }

    it("rejects with the repo and the config path, after the config was written", async () => {
      const deps = makeDeps(gatewayRefusing(forbidden()));
      const rejection = await runInit({ repos: ["o/r"] }, deps).catch((e: unknown) => e);
      expect(rejection).toBeInstanceOf(BootstrapFailure);
      const failure = rejection as BootstrapFailure;
      expect(failure.repo).toBe("o/r");
      expect(failure.configPath).toBe(path.join(deps.home, "config.json"));
      expect(failure.status).toBe(403);
      expect(deps.writes.has(failure.configPath)).toBe(true); // written before bootstrapping, so it survives
    });

    it("keeps GitHub's own words as the message, so the reason is not paraphrased away", async () => {
      const deps = makeDeps(gatewayRefusing(forbidden()));
      const rejection = await runInit({ repos: ["o/r"] }, deps).catch((e: unknown) => e);
      expect((rejection as BootstrapFailure).message).toBe("Resource not accessible by integration");
    });

    it("stops at the failing repo rather than reporting a partial bootstrap as success", async () => {
      const deps = makeDeps(gatewayRefusing(forbidden(), "o/r2"));
      await expect(runInit({ repos: ["o/r1", "o/r2"] }, deps)).rejects.toBeInstanceOf(BootstrapFailure);
    });
  });
});

describe("describeInitFailure", () => {
  const lines = (e: unknown): string => describeInitFailure(e).join("\n");

  it("names the repository, the Issues write permission, and the config already on disk on a 403", () => {
    const failure = new BootstrapFailure("o/r", "/home/me/.agent-peer-review/config.json", Object.assign(new Error("Resource not accessible by integration"), { status: 403 }));
    const message = lines(failure);
    expect(message).toContain("o/r");
    expect(message).toContain("Resource not accessible by integration"); // GitHub's own words, kept
    expect(message).toContain("Issues write");
    expect(message).toContain("/home/me/.agent-peer-review/config.json");
  });

  it("says the repository was not found on a 404, and still says the config was written", () => {
    const failure = new BootstrapFailure("o/typo", "/tmp/config.json", Object.assign(new Error("Not Found"), { status: 404 }));
    const message = lines(failure);
    expect(message).toContain("o/typo was not found");
    expect(message).not.toContain("Issues write"); // a missing repo is not a permission to grant
    expect(message).toContain("/tmp/config.json");
  });

  it("still names the repo and the config file on a status it has no advice for", () => {
    const failure = new BootstrapFailure("o/r", "/tmp/config.json", Object.assign(new Error("Server Error"), { status: 500 }));
    const message = lines(failure);
    expect(message).toContain("o/r");
    expect(message).toContain("/tmp/config.json");
  });

  it("keeps the friendly authentication message for a token failure", () => {
    expect(lines(Object.assign(new Error("Bad credentials"), { status: 401 }))).toBe(
      "Could not authenticate to GitHub. Set GITHUB_TOKEN or run `gh auth login`.",
    );
    expect(lines(new Error("No GitHub token: set GITHUB_TOKEN or run `gh auth login`."))).toContain("Could not authenticate");
  });

  it("treats a 403 or 404 that is not a bootstrap failure as an authentication problem too", () => {
    expect(lines(Object.assign(new Error("Resource not accessible by integration"), { status: 403 }))).toContain("Could not authenticate");
    expect(lines(Object.assign(new Error("Not Found"), { status: 404 }))).toContain("Could not authenticate");
  });

  it("passes any other error through unchanged", () => {
    expect(lines(new Error('invalid repo "nope": expected "owner/name"'))).toBe('Error: invalid repo "nope": expected "owner/name"');
  });
});

// Issue #67 item 2: reviewers and knownAgentLogins were flag-only, so the interactive path could
// finish reporting complete success and still leave the product unable to request a review.
describe("promptForInit", () => {
  // Answers the questions in order, by matching a distinctive word in each prompt, so a reordered
  // or reworded question fails loudly here instead of silently answering the wrong one.
  function scriptedAsk(answers: Record<string, string>) {
    const asked: string[] = [];
    const ask = async (question: string): Promise<string> => {
      asked.push(question);
      const match = Object.keys(answers).find((key) => question.includes(key));
      if (match === undefined) throw new Error(`unexpected question: ${question}`);
      return answers[match];
    };
    return { ask, asked };
  }

  it("collects reviewers and known agent logins, splitting and trimming each list", async () => {
    const { ask } = scriptedAsk({
      "Repositories": "o/r1, o/r2",
      "metadata capture": "n",
      "Default reviewers": "patextreme, yshyn-iohk ",
      "Known agent logins": " peer-bot,review-bot",
    });
    const answers = await promptForInit(ask);
    expect(answers.repos).toEqual(["o/r1", "o/r2"]);
    expect(answers.reviewers).toEqual(["patextreme", "yshyn-iohk"]);
    expect(answers.knownAgentLogins).toEqual(["peer-bot", "review-bot"]);
    expect(answers.captureMetadata).toBe(false);
  });

  it("leaves a skipped list undefined rather than empty, so an earlier run's value is not cleared", async () => {
    const { ask } = scriptedAsk({
      "Repositories": "o/r",
      "metadata capture": "n",
      "Default reviewers": "",
      "Known agent logins": "  ",
    });
    const answers = await promptForInit(ask);
    expect(answers.reviewers).toBeUndefined();
    expect(answers.knownAgentLogins).toBeUndefined();
  });

  it("asks for model and agent only when metadata capture was accepted", async () => {
    const declined = scriptedAsk({
      "Repositories": "o/r", "metadata capture": "n", "Default reviewers": "", "Known agent logins": "",
    });
    await promptForInit(declined.ask);
    expect(declined.asked.some((q) => q.includes("Model identifier"))).toBe(false);

    const accepted = scriptedAsk({
      "Repositories": "o/r", "metadata capture": "y", "Model identifier": "claude-opus-5",
      "Agent/host identifier": "claude-code", "Default reviewers": "", "Known agent logins": "",
    });
    const answers = await promptForInit(accepted.ask);
    expect(answers).toMatchObject({ captureMetadata: true, model: "claude-opus-5", agent: "claude-code" });
  });

  it("feeds runInit a config that carries both lists (the interactive path, end to end)", async () => {
    const { ask } = scriptedAsk({
      "Repositories": "o/r",
      "metadata capture": "n",
      "Default reviewers": "patextreme",
      "Known agent logins": "peer-bot",
    });
    const answers = await promptForInit(ask);
    const deps = makeDeps();
    const result = await runInit({ ...answers, toolVersion: undefined }, deps);

    expect(JSON.parse(deps.writes.get(result.configPath)!)).toEqual({
      captureMetadata: false, reviewers: ["patextreme"], knownAgentLogins: ["peer-bot"],
      githubLogin: "me", defaultRepo: "o/r",
    });
    expect(result.reviewers).toEqual(["patextreme"]);
    expect(result.knownAgentLogins).toEqual(["peer-bot"]);
  });
});
