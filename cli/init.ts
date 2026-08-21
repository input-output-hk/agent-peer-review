import path from "node:path";
import { UNREADABLE_CHECKS, type GitHubGateway } from "../core/github.js";
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
  // The three fields now on record after this call's merge, whether just written or carried over
  // from an existing config.json, so the CLI can name them in the printed summary. All three are
  // easy to forget and each has a failure mode a summary can head off: no defaultRepo means the
  // next command answers "--repo is required", no reviewers means the first `request` has nobody to
  // ask, and no knownAgentLogins means the expedition safety gate counts every peer agent as a
  // human (see AGENTS.md's install contract). The summary is the one place every install path reads.
  defaultRepo?: string;
  reviewers: string[];
  knownAgentLogins: string[];
  // Set when the best-effort expedition permission preflight below cannot confirm all read rails.
  // Never thrown: a probe failure must not fail init itself, only warn about it.
  expeditionPermissionsWarning?: string;
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

  // The token just authenticated, so record whose it is. Written unconditionally rather than only
  // when absent: the login is a fact about the token, not a preference, so after a token swap the
  // recorded login has to follow, or `list` keeps filtering by the previous account's name.
  config.githubLogin = login;

  // Only from a single --repo: with several passed there is no basis to elect one, and guessing
  // would silently point every later command at a repository the user never chose. An existing
  // defaultRepo always wins, since a hand-set default must survive a re-run of init. Without this,
  // `init --repo o/n --yes` reported success and the very next command answered "--repo is
  // required" (issue #67).
  if (input.repos.length === 1 && config.defaultRepo === undefined) config.defaultRepo = input.repos[0];

  deps.writeFile(configPath, JSON.stringify(config, null, 2) + "\n");

  const bootstrapped: InitResult["bootstrapped"] = [];
  for (const repo of input.repos) {
    let profile: Awaited<ReturnType<typeof bootstrap>>;
    try {
      profile = await bootstrap(deps.gateway, { repo });
    } catch (e) {
      // Wrapped, not propagated bare: the config file is already on disk at this point, and the
      // likeliest cause is a token without Issues write on this one repository. The CLI needs both
      // of those facts to say anything useful (see describeInitFailure).
      throw new BootstrapFailure(repo, configPath, e);
    }
    // InitResult has no "updated" bucket: a label that needed updating is, from init's point of
    // view, now freshly in place, so it is folded into "created" rather than silently dropped.
    bootstrapped.push({ repo, created: [...profile.created, ...profile.updated], unchanged: profile.unchanged });
  }

  const expeditionPermissionsWarning = await probeExpeditionPermissions(deps.gateway, input.repos);

  return {
    configPath,
    login,
    bootstrapped,
    // The values now on record, not just what this call passed: a re-run of `init` without
    // --reviewer or --known-agent-login still reports whatever an earlier run (or a hand edit)
    // already set, so the summary always reflects the file just written rather than only this
    // invocation's input.
    defaultRepo: typeof config.defaultRepo === "string" ? config.defaultRepo : undefined,
    reviewers: stringList(config.reviewers),
    knownAgentLogins: stringList(config.knownAgentLogins),
    expeditionPermissionsWarning,
  };
}

// Whatever is on record for a list field, defensively: config.json is hand-editable, so the value
// read back may be any JSON at all, and the summary must report what is usable rather than throw.
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * A failure in the label bootstrap, which runs after config.json has already been written. Carries
 * the repository, the config path, and the underlying error so the CLI can name all three; see
 * describeInitFailure for the message.
 */
export class BootstrapFailure extends Error {
  readonly repo: string;
  readonly configPath: string;
  readonly status?: number;

  constructor(repo: string, configPath: string, cause: unknown) {
    const err = cause as { status?: number; message?: string };
    super(err?.message ?? String(cause));
    this.name = "BootstrapFailure";
    this.repo = repo;
    this.configPath = configPath;
    this.status = err?.status;
  }
}

// 401 is a missing or invalid token. 403 and 404 mean "this token cannot do that here": GitHub
// answers a write the token is not scoped for with 403 "Resource not accessible by integration", and
// hides a repository the token cannot see behind 404 rather than admitting it exists. All three send
// the reader to the same first move, which is to check the token, so all three earn the friendly
// message rather than a bare error string.
const AUTH_STATUSES = [401, 403, 404];

function isAuthError(e: unknown): boolean {
  const err = e as { status?: number; message?: string };
  if (err?.status !== undefined && AUTH_STATUSES.includes(err.status)) return true;
  return /token|credentials|authenticat/i.test(err?.message ?? "");
}

/**
 * The lines the CLI prints when init fails. Lives here rather than in cli/index.ts so it can be
 * tested: cli/index.ts parses argv at module load and cannot be imported.
 */
export function describeInitFailure(e: unknown): string[] {
  if (e instanceof BootstrapFailure) {
    const lines = [`Could not create the review labels on ${e.repo}: ${e.message}`];
    if (e.status === 404) {
      lines.push(`${e.repo} was not found. Check the spelling, and that this token can see the repository.`);
    } else if (e.status === 403) {
      lines.push(`This token needs the Issues write permission on ${e.repo} to create labels ("Issues: read and write" on a fine-grained token, the "repo" scope on a classic one).`);
    }
    // Said in every case, including the ones with no permission advice to offer: the file on disk is
    // the surprising part. init writes the config before bootstrapping, so a failure here leaves a
    // usable config behind, and a user who assumes otherwise starts over from nothing.
    lines.push(`Your config was already written to ${e.configPath}, so nothing else is lost: fix the above and run init again.`);
    return lines;
  }
  if (isAuthError(e)) return ["Could not authenticate to GitHub. Set GITHUB_TOKEN or run `gh auth login`."];
  return [`Error: ${(e as Error).message}`];
}

/** Splits a comma-separated answer or flag value the way the CLI's own --reviewers/--skills do. */
export const parseList = (value: string): string[] => value.split(",").map((s) => s.trim()).filter(Boolean);

export interface InitAnswers {
  repos: string[];
  captureMetadata: boolean;
  model?: string;
  agent?: string;
  reviewers?: string[];
  knownAgentLogins?: string[];
}

/**
 * The interactive setup questions, over an injected `ask` (readline in the CLI, a scripted function
 * in tests). An empty answer for either list yields undefined rather than [], so pressing enter
 * leaves whatever an earlier run put in config.json alone instead of clearing it.
 */
export async function promptForInit(ask: (question: string) => Promise<string>): Promise<InitAnswers> {
  const repos = parseList(await ask("Repositories to bootstrap (owner/name, comma-separated): "));
  const captureAnswer = await ask(
    "Enable review metadata capture? This writes model/agent/machine into the public review (y/N): ",
  );
  const captureMetadata = ["y", "yes"].includes(captureAnswer.trim().toLowerCase());
  let model: string | undefined;
  let agent: string | undefined;
  if (captureMetadata) {
    model = (await ask("Model identifier (optional, press enter to skip): ")).trim() || undefined;
    agent = (await ask("Agent/host identifier (optional, press enter to skip): ")).trim() || undefined;
  }
  // Both lists are asked for here because both are needed before the product works and neither is
  // discoverable: without reviewers the first `request` has nobody to ask, and without
  // knownAgentLogins the expedition safety gate reads every peer agent as a human. They used to be
  // flag-only, so the interactive path could complete successfully and still not work (issue #67).
  const reviewers = parseList(await ask(
    "Default reviewers, the peer agent logins to request reviews from (comma-separated, enter to skip): ",
  ));
  const knownAgentLogins = parseList(await ask(
    "Known agent logins, the reviewers the safety gate should treat as agents rather than humans (comma-separated, enter to skip): ",
  ));
  return {
    repos, captureMetadata, model, agent,
    reviewers: reviewers.length > 0 ? reviewers : undefined,
    knownAgentLogins: knownAgentLogins.length > 0 ? knownAgentLogins : undefined,
  };
}

// Best-effort, read-only preflight for the four extra reads the expedition gate performs. Checks,
// commit statuses, and branch protection are needed in propose mode too; Dependabot alerts is a
// fail-closed rail in both modes. Contents:write is required only for a real merge and cannot be
// tested without making a write, so it is documented rather than probed here.
//
// Checked against the first repo only. Never allowed to fail init: each thrown error becomes an
// unreadable permission rather than propagating, since this is advisory, not a setup precondition.
async function probeExpeditionPermissions(gateway: GitHubGateway, repos: string[]): Promise<string | undefined> {
  if (repos.length === 0) return undefined;
  const repo = repos[0];
  const unreadable: string[] = [];
  let branch: string | undefined;
  try {
    branch = await gateway.getDefaultBranch(repo);
  } catch {
    unreadable.push("repository default branch (Metadata: read)");
  }

  if (branch !== undefined) {
    try {
      const checks = await gateway.getChecks(repo, branch);
      if (checks.some((check) => check.name === UNREADABLE_CHECKS)) {
        unreadable.push("checks or commit statuses (Checks: read and Commit statuses: read)");
      }
    } catch {
      unreadable.push("checks or commit statuses (Checks: read and Commit statuses: read)");
    }
    try {
      if (await gateway.getBranchProtection(repo, branch) === "unknown") {
        unreadable.push("branch protection (Administration: read)");
      }
    } catch {
      unreadable.push("branch protection (Administration: read)");
    }
  }

  try {
    if (await gateway.listOpenSecurityAlertCount(repo) === null) {
      unreadable.push('Dependabot alerts ("Dependabot alerts: read" or classic "security_events")');
    }
  } catch {
    unreadable.push('Dependabot alerts ("Dependabot alerts: read" or classic "security_events")');
  }

  if (unreadable.length === 0) return undefined;
  return (
    `Could not confirm the expedition permissions on ${repo}: ${unreadable.join("; ")}. See SECURITY.md. ` +
    `This does NOT affect requesting, claiming, or completing reviews. Expedition operations fail ` +
    `closed when a safety read is unavailable. Contents: write is additionally required for an ` +
    `autonomy=auto merge and cannot be probed safely by init.`
  );
}
