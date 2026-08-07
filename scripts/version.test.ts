import { describe, it, expect } from "vitest";
import { SPOTS, extract, setInText, computeVersion, applyVersion, checkVersions } from "./version.js";

// Realistic fragments mirroring the actual files, so the spot patterns are exercised against real shapes.
function fixture(version: string): Map<string, string> {
  return new Map<string, string>([
    ["package.json", `{\n  "name": "@input-output-hk/agent-review",\n  "version": "${version}",\n  "dependencies": { "zod": "^3.23.0" }\n}\n`],
    ["pi/package.json", `{\n  "name": "@input-output-hk/agent-review-pi",\n  "version": "${version}",\n  "dependencies": { "@input-output-hk/agent-review": "^${version}" }\n}\n`],
    ["dashboard/package.json", `{\n  "version": "${version}",\n  "dependencies": {\n    "@input-output-hk/agent-review": "^${version}",\n    "fastify": "^5.2.0"\n  }\n}\n`],
    ["cli/index.ts", `program.name("agent-review").description("Minimal async PR review over GitHub").version("${version}");\n`],
    ["mcp/server.ts", `  const server = new McpServer({ name: "agent-review", version: "${version}" });\n`],
  ]);
}

describe("computeVersion", () => {
  it("applies release-type keywords", () => {
    expect(computeVersion("0.4.0", "patch")).toBe("0.4.1");
    expect(computeVersion("0.4.0", "minor")).toBe("0.5.0");
    expect(computeVersion("0.4.0", "major")).toBe("1.0.0");
    expect(computeVersion("0.4.0", "prerelease")).toBe("0.4.1-0");
  });

  it("accepts an explicit greater version", () => {
    expect(computeVersion("0.4.0", "1.2.3")).toBe("1.2.3");
    expect(computeVersion("0.4.0", "0.4.1")).toBe("0.4.1");
  });

  it("rejects a non-increasing explicit version", () => {
    expect(() => computeVersion("0.4.0", "0.4.0")).toThrow(/not greater/);
    expect(() => computeVersion("0.4.0", "0.3.0")).toThrow(/not greater/);
  });

  it("rejects garbage", () => {
    expect(() => computeVersion("0.4.0", "latest")).toThrow(/invalid version/);
    expect(() => computeVersion("0.4.0", "")).toThrow(/invalid version/);
  });
});

describe("extract / setInText", () => {
  it("reads and rewrites only the version capture group", () => {
    const dep = `  "dependencies": { "@input-output-hk/agent-review": "^0.4.0" }`;
    const pat = SPOTS.find((s) => s.kind === "range")!.pattern;
    expect(extract(dep, pat)).toBe("0.4.0");
    const { text, found } = setInText(dep, pat, "0.5.0");
    expect(found).toBe(true);
    expect(text).toBe(`  "dependencies": { "@input-output-hk/agent-review": "^0.5.0" }`);
  });

  it("reports found=false when the pattern is absent", () => {
    const { found } = setInText("nothing here", /"version":\s*"([^"]+)"/, "1.0.0");
    expect(found).toBe(false);
  });

  it("replaces only the first match", () => {
    const two = `"version": "0.4.0"\nnested { "version": "9.9.9" }`;
    const { text } = setInText(two, /"version":\s*"([^"]+)"/, "0.5.0");
    expect(text).toBe(`"version": "0.5.0"\nnested { "version": "9.9.9" }`);
  });

  it("rewrites the mcp server version without touching the name", () => {
    const line = `const server = new McpServer({ name: "agent-review", version: "0.4.0" });`;
    const pat = SPOTS.find((s) => s.label === "mcp server version")!.pattern;
    const { text } = setInText(line, pat, "0.5.0");
    expect(text).toBe(`const server = new McpServer({ name: "agent-review", version: "0.5.0" });`);
  });
});

describe("applyVersion", () => {
  it("sets every spot to the new version, ranges included", () => {
    const { files, missing } = applyVersion(fixture("0.4.0"), "0.5.0");
    expect(missing).toEqual([]);
    // Every spot now reports 0.5.0.
    expect(checkVersions(files, "0.5.0")).toEqual([]);
    // Dep ranges keep their caret.
    expect(files.get("pi/package.json")).toContain(`"@input-output-hk/agent-review": "^0.5.0"`);
    expect(files.get("dashboard/package.json")).toContain(`"@input-output-hk/agent-review": "^0.5.0"`);
    // Package versions and the two source files.
    expect(files.get("package.json")).toContain(`"version": "0.5.0"`);
    expect(files.get("cli/index.ts")).toContain(`.version("0.5.0")`);
    expect(files.get("mcp/server.ts")).toContain(`version: "0.5.0"`);
  });

  it("reports spots it could not find", () => {
    const files = fixture("0.4.0");
    files.set("cli/index.ts", "// no version call here\n");
    const { missing } = applyVersion(files, "0.5.0");
    expect(missing.map((s) => s.label)).toEqual(["cli --version"]);
  });
});

describe("checkVersions", () => {
  it("passes when every spot agrees", () => {
    expect(checkVersions(fixture("0.4.0"), "0.4.0")).toEqual([]);
  });

  it("flags a single drifted spot", () => {
    const files = fixture("0.4.0");
    files.set("cli/index.ts", `program.name("agent-review").version("0.3.9");\n`);
    const mismatches = checkVersions(files, "0.4.0");
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ file: "cli/index.ts", found: "0.3.9", expected: "0.4.0" });
  });

  it("flags a missing file as not found", () => {
    const files = fixture("0.4.0");
    files.delete("mcp/server.ts");
    const mismatches = checkVersions(files, "0.4.0");
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].found).toBeNull();
  });
});
