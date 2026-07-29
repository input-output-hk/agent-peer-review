import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ConfigSchema, type Config } from "./model.js";

function candidatePaths(explicitPath?: string): string[] {
  return [
    explicitPath,
    process.env.AGENT_REVIEW_CONFIG,
    path.join(homedir(), ".config", "agent-review", "config.json"),
    path.join(process.cwd(), ".agent-review.json"),
  ].filter((p): p is string => Boolean(p));
}

export function loadConfig(explicitPath?: string): Config {
  for (const p of candidatePaths(explicitPath)) {
    if (existsSync(p)) return ConfigSchema.parse(JSON.parse(readFileSync(p, "utf8")));
  }
  return ConfigSchema.parse({});
}
