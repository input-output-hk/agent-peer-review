import { execFileSync } from "node:child_process";
import path from "node:path";

export interface ReviewWorkspaceState {
  headSha: string;
  clean: boolean;
}
function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new Error(`Cannot verify review workspace at ${path.resolve(cwd)}; use a clean checkout of the claimed pull request.`);
  }
}

function githubRepo(remote: string): string | null {
  const normalized = remote.trim().replace(/\.git$/i, "");
  const match = /(?:github\.com)(?::|\/)([^/]+)\/([^/]+)$/i.exec(normalized);
  return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * Read-only local attestation for review completion.
 *
 * The origin check prevents an unrelated clean repository that happens to contain the same commit
 * from satisfying the guard. Porcelain status includes staged, unstaged, and untracked files, so an
 * agent can never submit observations from a dirty checkout as though they described the PR head.
 */
export function inspectReviewWorkspace(repo: string, cwd = process.cwd()): ReviewWorkspaceState {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  const origin = githubRepo(git(root, ["remote", "get-url", "origin"]));
  if (origin?.toLowerCase() !== repo.toLowerCase()) {
    throw new Error(`Review workspace origin is ${origin ?? "not GitHub"}, expected ${repo}.`);
  }
  return {
    headSha: git(root, ["rev-parse", "HEAD"]),
    clean: git(root, ["status", "--porcelain=v1", "--untracked-files=all"]) === "",
  };
}
