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
  };
}

export function loadConfig(explicitPath?: string): Config {
  for (const p of candidatePaths(explicitPath)) {
    if (existsSync(p)) return applyEnvOverrides(ConfigSchema.parse(JSON.parse(readFileSync(p, "utf8"))));
  }
  return applyEnvOverrides(ConfigSchema.parse({}));
}
