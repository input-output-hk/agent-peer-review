import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Config } from "../core/index.js";
import { buildServer } from "../mcp/server.js";
import { FakeGitHubGateway } from "./fakes/fake-github.js";

const baseConfig: Config = { githubLogin: null, skillsDir: null, captureMetadata: false, reviewers: [], knownAgentLogins: [] };

// Connects a real MCP Client to buildServer()'s McpServer over an in-memory transport pair, so
// review_create's zod input schema and handler run exactly as they would for a real host, with no
// stdio/network involved. buildServer's injected gh/config (added alongside this test) stand in
// for OctokitGateway/loadConfig.
async function connectedClient(gh: FakeGitHubGateway, config: Config): Promise<Client> {
  const server = buildServer({ gh: () => gh, config: () => config });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(res: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = res.content as Array<{ type: string; text?: string }>;
  return content[0]?.text ?? "";
}

describe("mcp server: review_create reviewers fallback", () => {
  it("falls back to config.reviewers when the call omits reviewers", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 7, title: "t", author: "a", headSha: "s", baseSha: "b", url: "u", state: "open", labels: [] });
    const client = await connectedClient(gh, { ...baseConfig, reviewers: ["patextreme"] });

    const res = await client.callTool({ name: "review_create", arguments: { repo: "o/r", pr: 7 } });

    expect(res.isError).toBeFalsy();
    expect(JSON.parse(textOf(res)).reviewers).toEqual(["patextreme"]);
    expect(await gh.listReviewRequests("o/r", "patextreme")).toHaveLength(1); // config default reached the gateway
  });

  it("prefers an explicit reviewers list over the config default", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 7, title: "t", author: "a", headSha: "s", baseSha: "b", url: "u", state: "open", labels: [] });
    const client = await connectedClient(gh, { ...baseConfig, reviewers: ["patextreme"] });

    const res = await client.callTool({ name: "review_create", arguments: { repo: "o/r", pr: 7, reviewers: ["alice"] } });

    expect(res.isError).toBeFalsy();
    expect(JSON.parse(textOf(res)).reviewers).toEqual(["alice"]);
    expect(await gh.listReviewRequests("o/r", "patextreme")).toHaveLength(0); // the default was not used
  });

  it("reports a clear error when reviewers are empty everywhere", async () => {
    const gh = new FakeGitHubGateway();
    gh.seedPr({ number: 7, title: "t", author: "a", headSha: "s", baseSha: "b", url: "u", state: "open", labels: [] });
    const client = await connectedClient(gh, { ...baseConfig, reviewers: [] });

    const res = await client.callTool({ name: "review_create", arguments: { repo: "o/r", pr: 7 } });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/no reviewers/i);
  });
});
