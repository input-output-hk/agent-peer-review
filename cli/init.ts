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

/**
 * Guided setup: validate the token, write the global config, and bootstrap the label profile on
 * every requested repo. Pure aside from the injected gateway calls and `writeFile`; it never
 * prints, so the CLI (or any other caller) decides how to present the result.
 */
export async function runInit(input: InitInput, deps: InitDeps): Promise<InitResult> {
  for (const repo of input.repos) assertRepoShape(repo);

  // Also validates the token: getAuthenticatedLogin rejects (and runInit propagates) before
  // anything is written if GitHub cannot authenticate the caller.
  const login = await deps.gateway.getAuthenticatedLogin();

  const config: Record<string, unknown> = {};
  if (input.captureMetadata !== undefined) config.captureMetadata = input.captureMetadata;
  if (input.model !== undefined) config.model = input.model;
  if (input.agent !== undefined) config.agent = input.agent;
  if (input.toolVersion !== undefined) config.toolVersion = input.toolVersion;

  const configPath = path.join(deps.home, "config.json");
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
