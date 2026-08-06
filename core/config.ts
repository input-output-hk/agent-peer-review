import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ConfigSchema, type Config } from "./model.js";
import { agentHome } from "./paths.js";

function candidatePaths(explicitPath?: string): string[] {
  return [
    explicitPath,
    process.env.AGENT_REVIEW_CONFIG,
    path.join(agentHome(), "config.json"),
    path.join(homedir(), ".config", "agent-review", "config.json"),
    path.join(process.cwd(), ".agent-review.json"),
  ].filter((p): p is string => Boolean(p));
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes"].includes(value.toLowerCase());
}

// An unset env var must fall through to the config value, but so must one explicitly set to "" (for
// example, by a host that always exports the variable but leaves it blank). Only a non-empty value
// counts as an override.
const fromEnv = (v: string | undefined): string | undefined => (v && v.length > 0 ? v : undefined);

// Same fall-through rule as fromEnv, for a comma-separated list (parsed the same way the CLI's own
// --reviewers/--skills csv() helper does: split, trim, drop blanks). An unset variable, an empty
// string, or one that is only commas/whitespace all yield undefined rather than [], so the caller's
// `?? cfg.reviewers` falls through to the config value instead of clobbering it with an empty list.
const fromEnvList = (v: string | undefined): string[] | undefined => {
  const list = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
};

// Environment variables win over whatever the config file (or default) supplied, so a single
// invocation can override capture behavior without editing the file on disk.
function applyEnvOverrides(cfg: Config): Config {
  return {
    ...cfg,
    model: fromEnv(process.env.AGENT_REVIEW_MODEL) ?? cfg.model,
    agent: fromEnv(process.env.AGENT_REVIEW_AGENT) ?? cfg.agent,
    toolVersion: fromEnv(process.env.AGENT_REVIEW_TOOL_VERSION) ?? cfg.toolVersion,
    captureMetadata: process.env.AGENT_REVIEW_CAPTURE_METADATA !== undefined
      ? isTruthy(process.env.AGENT_REVIEW_CAPTURE_METADATA)
      : cfg.captureMetadata,
    reviewers: fromEnvList(process.env.AGENT_REVIEW_REVIEWERS) ?? cfg.reviewers,
  };
}

export function loadConfig(explicitPath?: string): Config {
  for (const p of candidatePaths(explicitPath)) {
    if (existsSync(p)) return applyEnvOverrides(ConfigSchema.parse(JSON.parse(readFileSync(p, "utf8"))));
  }
  return applyEnvOverrides(ConfigSchema.parse({}));
}
