import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import path from "node:path";
import type { Config } from "./model.js";

export function findPackageRoot(fromDir = path.dirname(fileURLToPath(import.meta.url))): string {
  let dir = fromDir;
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("package.json not found above " + fromDir);
    dir = parent;
  }
}

export function skillsRoot(config: Config): string {
  return config.skillsDir ?? path.join(findPackageRoot(), "skills");
}

export function schemasRoot(): string {
  return path.join(findPackageRoot(), "schemas");
}

// The single directory for global (per-user, cross-invocation) config and state: the config file,
// the dashboard's SQLite database, and room for future per-user caches or logs under the same root.
// `AGENT_PEER_REVIEW_HOME` overrides it; otherwise it defaults to `~/.agent-peer-review`. The
// published package is named `agent-review`, but the home directory follows the project/repository
// name `agent-peer-review`; the existing `AGENT_REVIEW_*` environment variables are unrelated and
// unchanged.
export function agentHome(): string {
  return process.env.AGENT_PEER_REVIEW_HOME || path.join(homedir(), ".agent-peer-review");
}

/** Like `agentHome`, but also creates the directory (recursively) for callers about to write into it. */
export function ensureAgentHome(): string {
  const dir = agentHome();
  mkdirSync(dir, { recursive: true });
  return dir;
}
