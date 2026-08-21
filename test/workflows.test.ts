import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = path.join(ROOT, ".github", "workflows");

function workflow(name: string): string {
  return readFileSync(path.join(WORKFLOWS, name), "utf8");
}

function job(name: string, jobName: string): string {
  const source = workflow(name);
  const start = source.indexOf(`  ${jobName}:\n`);
  if (start === -1) return "";
  const rest = source.slice(start + 2);
  const next = rest.search(/^  [a-zA-Z0-9_-]+:\n/m);
  return next === -1 ? source.slice(start) : source.slice(start, start + 2 + next);
}

describe("workflow supply-chain boundaries", () => {
  it("pins every external action to a full commit SHA", () => {
    const unpinned: string[] = [];
    for (const file of readdirSync(WORKFLOWS).filter((name) => name.endsWith(".yml")).sort()) {
      for (const [index, line] of workflow(file).split("\n").entries()) {
        const use = line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/)?.[1];
        if (!use || use.startsWith("./") || use.startsWith("docker://")) continue;
        if (!/@[0-9a-f]{40}$/.test(use)) unpinned.push(`${file}:${index + 1}: ${use}`);
      }
    }
    expect(unpinned, "mutable action references can change code without a repository commit").toEqual([]);
  });

  it.each(["release.yml", "publish.yml"])("%s rejects generated-schema drift", (file) => {
    expect(workflow(file)).toContain("- run: npm run check:schemas");
  });

  it("keeps repository dependencies out of the RELEASE_TOKEN job", () => {
    const privileged = job("release.yml", "release");
    expect(privileged).toContain("RELEASE_TOKEN: ${{ secrets.RELEASE_TOKEN }}");
    expect(privileged).toContain("environment: release");
    expect(privileged).toContain("RELEASE_ENVIRONMENT_CONFIGURED: ${{ vars.RELEASE_ENVIRONMENT_CONFIGURED }}");
    expect(privileged).toContain("node scripts/write-release.mjs");
    expect(privileged).not.toMatch(/npm (?:ci|install|test|run)/);
    expect(job("release.yml", "validate")).not.toContain("secrets.RELEASE_TOKEN");
    expect(workflow("release.yml")).toContain("It must not be a repository-level secret");
  });

  it("never lets a workflow-dispatch value select the privileged release checkout", () => {
    const source = workflow("release.yml");
    expect(source).not.toContain("ref: ${{ needs.resolve.outputs.sha }}");
    expect(job("release.yml", "validate")).toContain("ref: main");
    expect(job("release.yml", "release")).toContain("ref: main");
    expect(source.match(/RESOLVED_SHA: \$\{\{ needs\.resolve\.outputs\.sha \}\}/g)).toHaveLength(2);
  });

  it("publishes prebuilt tarballs in a clean environment-credentialed job with lifecycle scripts disabled", () => {
    const privileged = job("publish.yml", "publish");
    expect(privileged).not.toContain("packages: write");
    expect(privileged).toContain("NODE_AUTH_TOKEN: ${{ secrets.PACKAGE_TOKEN }}");
    expect(privileged).not.toContain("secrets.GITHUB_TOKEN");
    expect(privileged).toContain("RELEASE_ENVIRONMENT_CONFIGURED: ${{ vars.RELEASE_ENVIRONMENT_CONFIGURED }}");
    expect(privileged).toContain("actions/download-artifact@");
    expect(privileged).not.toContain("actions/checkout@");
    expect(privileged).not.toMatch(/npm (?:ci|install|test|run)/);
    expect(privileged.match(/npm publish \"\$TARBALL\" --ignore-scripts/g)).toHaveLength(2);

    const validate = job("publish.yml", "validate");
    expect(validate).toContain("npm pack --ignore-scripts");
    expect(validate).not.toContain("packages: write");
  });

  it("grants Pages write and OIDC only to the dependency-free deploy job", () => {
    expect(job("pages.yml", "build")).not.toMatch(/(?:pages|id-token): write/);
    const deploy = job("pages.yml", "deploy");
    expect(deploy).toContain("pages: write");
    expect(deploy).toContain("id-token: write");
    expect(deploy).not.toMatch(/npm (?:ci|install|test|run)/);
  });
});
