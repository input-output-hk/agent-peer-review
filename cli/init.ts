import path from "node:path";
import type { GitHubGateway } from "../core/github.js";
import { bootstrap } from "../core/index.js";

export interface InitInput {
  repos: string[]; // owner/name
  captureMetadata?: boolean;
  model?: string;
  agent?: string;
  toolVersion?: string;
  reviewers?: string[]; // default reviewers to request when a create call omits --reviewers
  knownAgentLogins?: string[]; // logins the expedition human-review rail should treat as agents
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
  // The knownAgentLogins now on record after this call's merge, whether just written or carried
  // over from an existing config.json, so the CLI can name it in the printed summary: it is easy to
  // forget (see AGENTS.md's install contract), and the summary is the one place every install path
  // reads.
  knownAgentLogins: string[];
  // Set when the best-effort Dependabot alerts probe below could not confirm the token can read
  // that endpoint. Never thrown: a probe failure must not fail init itself, only warn about it.
  securityAlertsWarning?: string;
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
  if (input.reviewers !== undefined) config.reviewers = input.reviewers;
  if (input.knownAgentLogins !== undefined) config.knownAgentLogins = input.knownAgentLogins;

  deps.writeFile(configPath, JSON.stringify(config, null, 2) + "\n");

  const bootstrapped: InitResult["bootstrapped"] = [];
  for (const repo of input.repos) {
    const { created, updated, unchanged } = await bootstrap(deps.gateway, { repo });
    // InitResult has no "updated" bucket: a label that needed updating is, from init's point of
    // view, now freshly in place, so it is folded into "created" rather than silently dropped.
    bootstrapped.push({ repo, created: [...created, ...updated], unchanged });
  }

  // The value now on record, not just what this call passed: a re-run of `init` without
  // --known-agent-login still reports whatever an earlier run (or a hand edit) already set, so the
  // summary always reflects the file just written rather than only this invocation's input.
  const knownAgentLogins = Array.isArray(config.knownAgentLogins)
    ? config.knownAgentLogins.filter((v): v is string => typeof v === "string")
    : [];

  const securityAlertsWarning = await probeSecurityAlertsAccess(deps.gateway, input.repos);

  return { configPath, login, bootstrapped, knownAgentLogins, securityAlertsWarning };
}

// Best-effort, read-only check that this token can read the Dependabot alerts endpoint: the
// permission the expedition auto paths (pr_expedite / pr_approve_dep_upgrade with
// autonomy: "auto") need before their security-alert rail can ever pass, on a fine-grained token
// "Dependabot alerts: read", on a classic one "security_events" (see SECURITY.md and issue #54).
// Neither permission is needed to request, claim, or complete a review.
//
// Checked against the first repo only: the permission itself is a property of the token, not of
// any one repository, so one sample is enough to tell whether the token can reach this endpoint at
// all. Never allowed to fail init: any thrown error is treated exactly like the gateway's own
// "cannot tell" sentinel (null) rather than propagating, since this is advisory, not a
// precondition for the rest of setup.
async function probeSecurityAlertsAccess(gateway: GitHubGateway, repos: string[]): Promise<string | undefined> {
  if (repos.length === 0) return undefined;
  const repo = repos[0];
  let alertCount: number | null;
  try {
    alertCount = await gateway.listOpenSecurityAlertCount(repo);
  } catch {
    alertCount = null;
  }
  if (alertCount !== null) return undefined;
  return (
    `Could not read Dependabot alerts on ${repo}. This token may be missing "Dependabot alerts: read" ` +
    `(fine-grained) or "security_events" (classic); see SECURITY.md. This does NOT affect requesting, ` +
    `claiming, or completing reviews. It only means autonomy=auto on the expedition taskflows ` +
    `(pr_expedite, pr_approve_dep_upgrade) can never approve or merge anything: that safety rail ` +
    `fails closed whenever it cannot read the alert count.`
  );
}
