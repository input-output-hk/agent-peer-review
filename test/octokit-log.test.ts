import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Issue #67 item 5: @octokit/plugin-request-log narrates a failed request through `log.error`, which
// Octokit routes to console.error by default, so `GET /user - 401 with id ... in 570ms` printed above
// the CLI's own friendly message and read like a crash.
//
// This runs in a subprocess, which is the only place the claim can honestly be tested. In-process
// spies cannot see it: @octokit/core binds its default logger to console.error and console.warn at
// module load, so a later spy on those properties is never consulted, and under vitest that captured
// reference is vitest's own console, which never reaches process.stderr either. What a user sees is
// the child's streams, so that is what is asserted. No network: the gateway's `fetch` seam serves
// both responses.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = path.join(repoRoot, "node_modules", ".bin", "tsx");
const gatewayModule = path.join(repoRoot, "core", "github.ts");

// Two calls through the real gateway: one request that fails with a 401, and one call to a REST
// method Octokit itself reports as deprecated through `log.warn`. Written outside the repository so
// the repo's own typecheck and test globs never pick it up.
const script = `
import { OctokitGateway } from ${JSON.stringify(gatewayModule)};

const respond = (status, body) => async () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const failing = new OctokitGateway("bad-token", respond(401, { message: "Bad credentials" }));
try {
  await failing.getAuthenticatedLogin();
  process.stdout.write("UNEXPECTED SUCCESS\\n");
} catch (e) {
  process.stdout.write("CAUGHT " + e.message + "\\n");
}

// search.issuesAndPullRequests is deprecated in @octokit/plugin-rest-endpoint-methods, which says so
// through octokit.log.warn: a live warning that has no route out other than the log.
const searching = new OctokitGateway("fake-token", respond(200, { total_count: 0, incomplete_results: false, items: [] }));
process.stdout.write("FOUND " + (await searching.listReviewRequests("o/r", "me")).length + "\\n");
`;

function runScript(): { status: number | null; stdout: string; stderr: string } {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "octokit-log-")), "probe.mts");
  writeFileSync(file, script);
  const res = spawnSync(tsx, [file], { cwd: repoRoot, encoding: "utf8", timeout: 30_000 });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe("OctokitGateway request logging (subprocess)", () => {
  const res = runScript();

  it("prints nothing about the failed request, and still throws it to the caller", () => {
    expect(res.stdout).toContain("CAUGHT Bad credentials"); // the caller decides what the user reads
    expect(res.stdout + res.stderr).not.toMatch(/GET \/user - 401/);
  });

  it("keeps warnings: a deprecation notice Octokit sends through log.warn still reaches stderr", () => {
    // The log is the only route that message has, so silencing warn along with the rest would lose
    // it outright, and the constructor's own rate-limit hooks with it.
    expect(res.stdout).toContain("FOUND 0");
    expect(res.stderr).toMatch(/is deprecated/);
  });
});
