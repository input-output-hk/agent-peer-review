import path from "node:path";
import type { GitHubGateway } from "../core/github.js";
import { bootstrap } from "../core/index.js";

export interface InitInput {
  repos: string[]; // owner/name
  captureMetadata?: boolean;
  model?: string;
  agent?: string;
  toolVersion?: string;
}

export interface InitDeps {
  gateway: GitHubGateway; // OctokitGateway in prod, a fake in tests
  home: string; // agentHome() in prod, a temp dir in tests; the caller ensures it exists
  readFile: (path: string) => string | undefined; // undefined when the file does not exist
  writeFile: (path: string, contents: string) => void;
  log: (line: string) => void;
}

export interface InitResult {
  configPath: string;
  login: string;
  bootstrapped: Array<{ repo: string; created: string[]; unchanged: string[] }>;
}

const REPO_SHAPE = /^[^\s/]+\/[^\s/]+$/;

function assertRepoShape(repo: string): void {
  if (!REPO_SHAPE.test(repo)) throw new Error(`invalid repo "${repo}": expected "owner/name"`);
}

// Reads whatever is at configPath (undefined if nothing is there yet) and returns the object to
// merge new keys over. Anything that isn't a usable JSON object, whether unparseable or parseable
// to a non-object (an array, a string, ...), is treated the same way: refuse rather than guess, so
// a hand-edited or corrupt file is never silently clobbered.
function readExistingConfig(raw: string | undefined, configPath: string): Record<string, unknown> {
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`existing config at ${configPath} is not valid JSON; fix or remove it before running init`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Guided setup: validate the token, merge the provided keys into the global config, and bootstrap
 * the label profile on every requested repo. Pure aside from the injected gateway calls,
 * `readFile`, and `writeFile`; it never prints, so the CLI (or any other caller) decides how to
 * present the result.
 */
export async function runInit(input: InitInput, deps: InitDeps): Promise<InitResult> {
  for (const repo of input.repos) assertRepoShape(repo);

  // Also validates the token: getAuthenticatedLogin rejects (and runInit propagates) before
  // anything is read or written if GitHub cannot authenticate the caller.
  const login = await deps.gateway.getAuthenticatedLogin();

  const configPath = path.join(deps.home, "config.json");

  // Merge over whatever is already there rather than overwrite it, so a hand-edited config.json
  // (or one from a previous init) keeps every key this call doesn't touch, such as defaultRepo or
  // skillsDir. Read the file directly by path rather than via loadConfig, which applies env
  // overrides, schema defaults, and searches other candidate paths; here we want exactly, and
  // only, what is on disk at this one path.
  const config = readExistingConfig(deps.readFile(configPath), configPath);
  if (input.captureMetadata !== undefined) config.captureMetadata = input.captureMetadata;
  if (input.model !== undefined) config.model = input.model;
  if (input.agent !== undefined) config.agent = input.agent;
  if (input.toolVersion !== undefined) config.toolVersion = input.toolVersion;

  deps.writeFile(configPath, JSON.stringify(config, null, 2) + "\n");

  const bootstrapped: InitResult["bootstrapped"] = [];
  for (const repo of input.repos) {
    const { created, updated, unchanged } = await bootstrap(deps.gateway, { repo });
    // InitResult has no "updated" bucket: a label that needed updating is, from init's point of
    // view, now freshly in place, so it is folded into "created" rather than silently dropped.
    bootstrapped.push({ repo, created: [...created, ...updated], unchanged });
  }

  return { configPath, login, bootstrapped };
}
