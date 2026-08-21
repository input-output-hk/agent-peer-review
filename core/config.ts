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
    knownAgentLogins: fromEnvList(process.env.AGENT_REVIEW_KNOWN_AGENTS) ?? cfg.knownAgentLogins,
  };
}

const CONFIG_FIELDS = Object.keys(ConfigSchema.shape);

// Fields an earlier version of this tool accepted and this one does not. A config file written
// months ago is one of the likelier ways to meet the unknown-key error, and "did you mean" has
// nothing to offer for a field that was deliberately deleted, so name the removal instead. Add an
// entry here whenever a field leaves ConfigSchema.
const REMOVED_FIELDS: Record<string, string> = {
  runChecks: 'removed with issue #55. The review is unconditionally read-only now (see SECURITY.md); delete the key.',
};

// Levenshtein distance, two-row form. Only ever run over the handful of keys in one config file
// against the schema's ten field names, so the naive implementation is the right one.
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length];
}

// The field an unknown key was most likely meant to be, or undefined when nothing is close enough.
// Case-insensitive because a wrong case is a typo too. Two edits is the widest gap that still reads
// as a slip of the same name (knownAgentLogin -> knownAgentLogins, reviewer -> reviewers); past that
// a suggestion is a guess, and a confidently wrong one costs the reader more than silence.
function nearestField(key: string): string | undefined {
  let best: { field: string; distance: number } | undefined;
  for (const field of CONFIG_FIELDS) {
    const distance = editDistance(key.toLowerCase(), field.toLowerCase());
    if (!best || distance < best.distance) best = { field, distance };
  }
  return best && best.distance <= 2 && best.distance < key.length ? best.field : undefined;
}

// zod's own text ("Unrecognized key(s) in object: 'knownAgentLogin'") is accurate and unhelpful: it
// names neither the file it came from nor a way forward, and it arrives wrapped in a ZodError dump.
// This says which file, which key, what it was probably meant to be, and what the valid fields are.
function describeUnknownKeys(keys: string[], file: string): string {
  const lines = [`Unknown ${keys.length === 1 ? "key" : "keys"} in ${file}:`];
  for (const key of keys) {
    const removed = REMOVED_FIELDS[key];
    if (removed) lines.push(`  "${key}": ${removed}`);
    else {
      const near = nearestField(key);
      lines.push(`  "${key}": ${near ? `did you mean "${near}"?` : "not a config field."}`);
    }
  }
  lines.push(`Valid fields: ${CONFIG_FIELDS.join(", ")}.`);
  return lines.join("\n");
}

/** Validate one config object with the same file-aware diagnostics loadConfig uses. */
export function parseConfig(raw: unknown, file: string): Config {
  const result = ConfigSchema.safeParse(raw);
  if (result.success) return result.data;
  const unknown = result.error.issues.flatMap((i) => (i.code === "unrecognized_keys" ? i.keys : []));
  if (unknown.length > 0) throw new Error(describeUnknownKeys(unknown, file));
  throw result.error; // a wrong type or shape: unchanged from ConfigSchema.parse
}

export function loadConfig(explicitPath?: string): Config {
  for (const p of candidatePaths(explicitPath)) {
    if (existsSync(p)) return applyEnvOverrides(parseConfig(JSON.parse(readFileSync(p, "utf8")), p));
  }
  return applyEnvOverrides(ConfigSchema.parse({}));
}
