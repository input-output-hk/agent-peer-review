// Discover the pull requests waiting on this account as a reviewer, one JSON array on stdout.
//
// Two buckets, unioned per repository:
//   kind "requested" - a review is requested from this account right now.
//   kind "watching"  - this account has already reviewed the pull request, so the flow has to ask
//                      what changed since.
// An item in both buckets is "requested": a live request outranks a follow-up.
//
// Zero dependencies on purpose: this file is copied into a consumer's repository and has to run
// there with nothing installed but Node and the GitHub CLI. It imports only Node built-ins, and it
// reads GitHub through `gh --json` exclusively, never by parsing human-readable output.
//
// Contract with the flow: stdout carries exactly one JSON array and nothing else, so every
// diagnostic goes to stderr. An empty array is a valid, successful answer.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dirname;
const CONFIG_PATH = join(HERE, "config.json");
const MAX_PER_REPO = 100;
const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Values that reach `gh` as arguments are checked first. There is no shell here (execFileSync
 * passes an argv array), so this is not about shell injection: it stops a config value from being
 * read by `gh` as an option (a leading "-") and keeps repository names to the character set GitHub
 * actually allows. The scan is linear, with no regex, because the same helper guards values that
 * arrive from a file this script did not write.
 */
function isSafeArgValue(value) {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > 200) return false;
  if (value.startsWith("-")) return false;
  for (const ch of value) {
    const ok =
      (ch >= "a" && ch <= "z") ||
      (ch >= "A" && ch <= "Z") ||
      (ch >= "0" && ch <= "9") ||
      ch === "-" || ch === "_" || ch === "." || ch === "/";
    if (!ok) return false;
  }
  return true;
}

/** An `owner/name` slug: safe characters and exactly one separator. */
function isRepoSlug(value) {
  if (!isSafeArgValue(value)) return false;
  let slashes = 0;
  for (const ch of value) if (ch === "/") slashes += 1;
  return slashes === 1;
}

/**
 * Read `config.json` from this directory. A missing or unreadable file is not an error: it means
 * this flow has not been configured yet, so there is nothing to discover. `config.example.json`
 * documents the same shape but is never read, so a forgotten copy step can never make this script
 * act on the example's placeholder repository.
 */
function loadConfig() {
  let raw;
  try {
    raw = readFileSync(CONFIG_PATH, "utf8");
  } catch {
    process.stderr.write(`[pr-reviewer] no ${CONFIG_PATH}; copy config.example.json to config.json and list your repositories\n`);
    return { repos: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    process.stderr.write(`[pr-reviewer] ${CONFIG_PATH} is not valid JSON: ${error instanceof Error ? error.message : String(error)}\n`);
    return { repos: [] };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    process.stderr.write(`[pr-reviewer] ${CONFIG_PATH} must hold a JSON object\n`);
    return { repos: [] };
  }
  const repos = [];
  for (const entry of Array.isArray(parsed.repos) ? parsed.repos : []) {
    if (isRepoSlug(entry)) repos.push(entry);
    else process.stderr.write(`[pr-reviewer] skipping malformed "repos" entry: ${JSON.stringify(entry)}\n`);
  }
  return { repos };
}

/** Run `gh` and parse its JSON. Returns null when the call fails, so one bad repository cannot
 *  end the run: `gh` already wrote its own error to stderr. */
function ghJson(args, label) {
  let stdout;
  try {
    stdout = execFileSync("gh", args, { encoding: "utf8", maxBuffer: MAX_BUFFER });
  } catch (error) {
    process.stderr.write(`[pr-reviewer] ${label} failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return null;
  }
  try {
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed)) {
      process.stderr.write(`[pr-reviewer] ${label} did not return a JSON array\n`);
      return null;
    }
    // Every call here passes "--limit" MAX_PER_REPO, and gh silently truncates at that cap rather
    // than reporting whether more results existed. A returned count at (or, defensively, past) the
    // cap is the only signal available that some may be missing from this run.
    if (parsed.length >= MAX_PER_REPO) {
      process.stderr.write(`[pr-reviewer] ${label}: hit the --limit ${MAX_PER_REPO} cap; there may be more results than were returned\n`);
    }
    return parsed;
  } catch (error) {
    process.stderr.write(`[pr-reviewer] ${label} returned unparseable JSON: ${error instanceof Error ? error.message : String(error)}\n`);
    return null;
  }
}

/**
 * List one repository's open pull requests matching a search qualifier.
 *
 * The `--search` form of `gh pr list` is backed by GitHub's Search API, which carries a much
 * tighter rate limit than the REST listing this flow's sibling uses. Both qualifiers here
 * (review-requested, reviewed-by) exist only in Search, so there is no REST equivalent to prefer.
 * The deferred optimization is to list the repository's open pull requests once over REST and
 * resolve requested reviewers and prior reviews per pull request; that trades one Search call for
 * N REST calls, so it only pays off on repositories with few open pull requests.
 */
function listBySearch(repo, qualifier, label) {
  return ghJson(
    [
      "pr", "list",
      "--repo", repo,
      "--search", qualifier,
      "--state", "open",
      "--limit", String(MAX_PER_REPO),
      "--json", "number,title,headRefOid,url",
    ],
    `${label} for ${repo}`,
  );
}

function main() {
  const { repos } = loadConfig();
  // Keyed by "<repo>#<number>" so the two buckets union cleanly.
  const byKey = new Map();

  const collect = (repo, pulls, kind) => {
    for (const pull of pulls) {
      if (pull === null || typeof pull !== "object") continue;
      if (typeof pull.number !== "number") continue;
      const key = `${repo}#${pull.number}`;
      const existing = byKey.get(key);
      // A live request outranks a follow-up, whichever bucket got there first.
      if (existing !== undefined && (existing.kind === "requested" || kind === "watching")) continue;
      byKey.set(key, {
        repo,
        number: pull.number,
        title: typeof pull.title === "string" ? pull.title : "",
        headSha: typeof pull.headRefOid === "string" ? pull.headRefOid : "",
        url: typeof pull.url === "string" ? pull.url : "",
        kind,
      });
    }
  };

  for (const repo of repos) {
    const requested = listBySearch(repo, "review-requested:@me", "review-requested list");
    if (requested !== null) collect(repo, requested, "requested");

    const watching = listBySearch(repo, "reviewed-by:@me", "reviewed-by list");
    if (watching !== null) collect(repo, watching, "watching");
  }

  const items = Array.from(byKey.values());
  const requestedCount = items.filter((item) => item.kind === "requested").length;
  process.stderr.write(
    `[pr-reviewer] ${items.length} candidate pull request(s) across ${repos.length} repository/repositories ` +
      `(${requestedCount} requested, ${items.length - requestedCount} watching)\n`,
  );
  process.stdout.write(JSON.stringify(items));
}

main();
