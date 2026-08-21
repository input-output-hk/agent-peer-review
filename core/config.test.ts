import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "./config.js";

describe("config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads and validates an explicit config file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ githubLogin: "yshyn-iohk" }));
    const cfg = loadConfig(file);
    expect(cfg.githubLogin).toBe("yshyn-iohk");
    expect(cfg.skillsDir).toBeNull();
  });
  it("applies defaults for an empty config file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, "{}");
    const cfg = loadConfig(file);
    expect(cfg.githubLogin).toBeNull();
    expect(cfg.captureMetadata).toBe(false); // opt-in metadata capture is off unless set
    expect(cfg.reviewers).toEqual([]); // no default reviewers unless configured
    expect(cfg.knownAgentLogins).toEqual([]); // no default known agents unless configured
  });
  it("parses reviewers from a config file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ reviewers: ["patextreme", "yshyn-iohk"] }));
    expect(loadConfig(file).reviewers).toEqual(["patextreme", "yshyn-iohk"]);
  });
  it("parses knownAgentLogins from a config file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ knownAgentLogins: ["peer-bot", "yshyn-iohk"] }));
    // Stubbed to unset (rather than relying on the ambient shell not exporting it) so this test
    // reads the file value deterministically instead of an env override winning by accident.
    vi.stubEnv("AGENT_REVIEW_KNOWN_AGENTS", "");
    expect(loadConfig(file).knownAgentLogins).toEqual(["peer-bot", "yshyn-iohk"]);
  });
  it("reads model/agent/toolVersion/captureMetadata from env vars", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, "{}");
    vi.stubEnv("AGENT_REVIEW_MODEL", "claude-opus-4-8");
    vi.stubEnv("AGENT_REVIEW_AGENT", "claude-code");
    vi.stubEnv("AGENT_REVIEW_TOOL_VERSION", "1.2.3");
    vi.stubEnv("AGENT_REVIEW_CAPTURE_METADATA", "true");
    const cfg = loadConfig(file);
    expect(cfg.model).toBe("claude-opus-4-8");
    expect(cfg.agent).toBe("claude-code");
    expect(cfg.toolVersion).toBe("1.2.3");
    expect(cfg.captureMetadata).toBe(true);
  });
  it("an env var overrides a config file value", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ captureMetadata: true }));
    vi.stubEnv("AGENT_REVIEW_CAPTURE_METADATA", "false");
    expect(loadConfig(file).captureMetadata).toBe(false);
  });
  it("an empty-string env var does not clobber the config file value (regression)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ model: "claude-opus-4-8" }));
    vi.stubEnv("AGENT_REVIEW_MODEL", "");
    expect(loadConfig(file).model).toBe("claude-opus-4-8");
  });
  it("an empty-string env var does not clobber the default (undefined) value (regression)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, "{}");
    vi.stubEnv("AGENT_REVIEW_MODEL", "");
    expect(loadConfig(file).model).toBeUndefined();
  });
  it("a non-empty env var still overrides the config file value", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ model: "claude-opus-4-8" }));
    vi.stubEnv("AGENT_REVIEW_MODEL", "x");
    expect(loadConfig(file).model).toBe("x");
  });
  it("AGENT_REVIEW_REVIEWERS parses a comma-separated list, trimming whitespace", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, "{}");
    vi.stubEnv("AGENT_REVIEW_REVIEWERS", "alice, bob ,  carol");
    expect(loadConfig(file).reviewers).toEqual(["alice", "bob", "carol"]);
  });
  it("a set AGENT_REVIEW_REVIEWERS overrides a config file's reviewers list", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ reviewers: ["patextreme"] }));
    vi.stubEnv("AGENT_REVIEW_REVIEWERS", "alice");
    expect(loadConfig(file).reviewers).toEqual(["alice"]);
  });
  it("an empty-string AGENT_REVIEW_REVIEWERS does not clobber the config file value (regression)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ reviewers: ["patextreme"] }));
    vi.stubEnv("AGENT_REVIEW_REVIEWERS", "");
    expect(loadConfig(file).reviewers).toEqual(["patextreme"]);
  });
  it("an unset AGENT_REVIEW_REVIEWERS leaves the default [] in place", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, "{}");
    expect(loadConfig(file).reviewers).toEqual([]);
  });
  it("AGENT_REVIEW_KNOWN_AGENTS parses a comma-separated list, trimming whitespace", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, "{}");
    vi.stubEnv("AGENT_REVIEW_KNOWN_AGENTS", "peer-bot, review-bot ,  ci-bot");
    expect(loadConfig(file).knownAgentLogins).toEqual(["peer-bot", "review-bot", "ci-bot"]);
  });
  it("a set AGENT_REVIEW_KNOWN_AGENTS overrides a config file's knownAgentLogins list", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ knownAgentLogins: ["patextreme"] }));
    vi.stubEnv("AGENT_REVIEW_KNOWN_AGENTS", "peer-bot");
    expect(loadConfig(file).knownAgentLogins).toEqual(["peer-bot"]);
  });
  it("an empty-string AGENT_REVIEW_KNOWN_AGENTS does not clobber the config file value (regression)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ knownAgentLogins: ["patextreme"] }));
    vi.stubEnv("AGENT_REVIEW_KNOWN_AGENTS", "");
    expect(loadConfig(file).knownAgentLogins).toEqual(["patextreme"]);
  });
  it("an unset AGENT_REVIEW_KNOWN_AGENTS leaves the default [] in place", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "config.json");
    writeFileSync(file, "{}");
    expect(loadConfig(file).knownAgentLogins).toEqual([]);
  });
  // Issue #67 item 3: the schema used to strip unknown keys, so a config of
  // {"knownAgentLogin": [...], "reviewer": [...], "defaultRepoo": "a/b"} loaded as all defaults,
  // exit 0, no warning. schemas/config.schema.json has always said additionalProperties: false.
  describe("an unknown key is rejected, not discarded (issue #67)", () => {
    const write = (config: unknown): string => {
      const file = path.join(mkdtempSync(path.join(tmpdir(), "cfg-")), "config.json");
      writeFileSync(file, JSON.stringify(config));
      return file;
    };

    it("names the file, the key, and the field it was probably meant to be", () => {
      const file = write({ knownAgentLogin: ["peer-bot"] });
      expect(() => loadConfig(file)).toThrow(file);
      expect(() => loadConfig(file)).toThrow(/"knownAgentLogin": did you mean "knownAgentLogins"\?/);
    });

    it("suggests the singular-to-plural near miss on reviewers too", () => {
      expect(() => loadConfig(write({ reviewer: ["alice"] }))).toThrow(/"reviewer": did you mean "reviewers"\?/);
    });

    it("suggests the nearest field for a doubled letter", () => {
      expect(() => loadConfig(write({ defaultRepoo: "a/b" }))).toThrow(/"defaultRepoo": did you mean "defaultRepo"\?/);
    });

    it("reports every unknown key at once rather than one per run", () => {
      const message = (() => {
        try { loadConfig(write({ knownAgentLogin: [], reviewer: [], defaultRepoo: "a/b" })); return ""; }
        catch (e) { return (e as Error).message; }
      })();
      expect(message).toContain("knownAgentLogin");
      expect(message).toContain("reviewer");
      expect(message).toContain("defaultRepoo");
      expect(message).toContain("Valid fields:"); // the full list, once, at the end
      expect(message).toContain("knownAgentLogins");
    });

    it("offers no suggestion for a key that resembles nothing, and still lists the valid fields", () => {
      const file = write({ somethingElseEntirely: 1 });
      expect(() => loadConfig(file)).toThrow(/"somethingElseEntirely": not a config field\./);
      expect(() => loadConfig(file)).toThrow(/Valid fields: githubLogin, defaultRepo/);
    });

    // A config written by an older version of this tool, which accepted runChecks. It resembles no
    // current field, so a near-miss suggestion would be silence; the removal is what to say instead.
    it("explains a field an older version wrote instead of guessing at a near miss", () => {
      const file = write({ githubLogin: "me", runChecks: false });
      expect(() => loadConfig(file)).toThrow(/"runChecks": removed with issue #55/);
      expect(() => loadConfig(file)).toThrow(/delete the key/);
    });

    it("still reports a wrong type the way it always did", () => {
      // Not an unknown key: the field exists and its value is wrong, so the zod error stands.
      expect(() => loadConfig(write({ reviewers: "alice" }))).toThrow(/expected array|Expected array/i);
    });

    it("accepts every field the schema declares, so the strictness cannot reject a valid config", () => {
      const file = write({
        githubLogin: "me", defaultRepo: "o/r", skillsDir: "/x", model: "m", agent: "a", toolVersion: "1.2.3",
        captureMetadata: true, reviewers: ["alice"], knownAgentLogins: ["peer-bot"],
        mergeMethodByRepo: { "o/r": "squash" },
      });
      expect(loadConfig(file).defaultRepo).toBe("o/r");
    });
  });

  it("falls back to <agentHome>/config.json when no explicit path or AGENT_REVIEW_CONFIG is set", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-home-"));
    vi.stubEnv("AGENT_PEER_REVIEW_HOME", dir);
    vi.stubEnv("AGENT_REVIEW_CONFIG", "");
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ githubLogin: "from-agent-home" }));
    expect(loadConfig().githubLogin).toBe("from-agent-home");
  });
});
