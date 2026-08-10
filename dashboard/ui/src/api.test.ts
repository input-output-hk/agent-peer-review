import { describe, it, expect, afterEach, vi } from "vitest";
import { getOverview, listRepos, listPulls, getPullDetail, listSyncRuns, listAgents, listCollaborators } from "./api";
import type { Overview, RepoSummary, PullSummary, PullDetail, SyncRun, AgentSummary, CollaboratorSummary } from "./types";

/** Stubs the global `fetch` to resolve with the given body and status. */
function stubFetch(body: unknown, ok = true, status = 200) {
  const fn = vi.fn().mockResolvedValue({ ok, status, json: async () => body });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getOverview", () => {
  it("fetches /api/overview and returns the typed body", async () => {
    const fixture: Overview = {
      totals: { repos: 1, pulls: 2, reviews: 3 },
      verdicts: [{ verdict: "approve", count: 2 }],
      models: [{ model: "claude-opus-4-8", count: 2 }],
      activity: [{ day: "2026-01-01", count: 1 }],
      lastSync: { startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:05:00Z", ok: true, counts: { pulls: 2 } },
    };
    const fetchMock = stubFetch(fixture);

    const result = await getOverview();

    expect(fetchMock).toHaveBeenCalledWith("/api/overview");
    expect(result).toEqual(fixture);
  });
});

describe("listRepos", () => {
  it("fetches /api/repos and returns the typed body", async () => {
    const fixture: RepoSummary[] = [{ owner: "acme", name: "widgets", pulls: 4 }];
    const fetchMock = stubFetch(fixture);

    const result = await listRepos();

    expect(fetchMock).toHaveBeenCalledWith("/api/repos");
    expect(result).toEqual(fixture);
  });
});

describe("listPulls", () => {
  it("URL-encodes a repo name with special characters and returns the typed body", async () => {
    const fixture: PullSummary[] = [
      {
        number: 7,
        title: "Add X",
        author: "alice",
        state: "open",
        url: "https://gh/pr/7",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
        mergedAt: null,
        reviews: 1,
        primaryVerdict: "approve",
      },
    ];
    const fetchMock = stubFetch(fixture);

    const result = await listPulls("my org", "repo name+extra");

    expect(fetchMock).toHaveBeenCalledWith("/api/repos/my%20org/repo%20name%2Bextra/pulls");
    expect(result).toEqual(fixture);
  });
});

describe("getPullDetail", () => {
  it("URL-encodes owner, name, and the pull number and returns the typed body", async () => {
    const fixture: PullDetail = {
      pull: {
        number: 42,
        title: "Fix Y",
        author: "bob",
        state: "merged",
        url: "https://gh/pr/42",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
        mergedAt: "2026-01-03T00:00:00Z",
        reviews: 2,
        primaryVerdict: "approve",
        headSha: "abc123",
        baseSha: "def456",
        repo: { owner: "my org", name: "repo name+extra" },
      },
      reviews: [],
      notes: [],
      claims: [],
      participants: [],
    };
    const fetchMock = stubFetch(fixture);

    const result = await getPullDetail("my org", "repo name+extra", 42);

    expect(fetchMock).toHaveBeenCalledWith("/api/repos/my%20org/repo%20name%2Bextra/pulls/42");
    expect(result).toEqual(fixture);
  });
});

describe("listSyncRuns", () => {
  it("fetches /api/sync-runs and returns the typed body", async () => {
    const fixture: SyncRun[] = [
      { startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:05:00Z", ok: true, repos: ["o/r"], counts: { pulls: 1 } },
    ];
    const fetchMock = stubFetch(fixture);

    const result = await listSyncRuns();

    expect(fetchMock).toHaveBeenCalledWith("/api/sync-runs");
    expect(result).toEqual(fixture);
  });
});

describe("listAgents", () => {
  const fixture: AgentSummary[] = [
    {
      agent: "claude-code",
      model: "claude-opus-4-8",
      reviews: 5,
      primaries: 3,
      enrichments: 2,
      verdicts: { approve: 3, agree: 1 },
      agreement: { agree: 1, disagree: 0, mixed: 0 },
      avgTurnaroundSeconds: 125,
      lastActiveAt: "2026-01-05T00:00:00Z",
      repos: 2,
    },
  ];

  it("fetches /api/agents with no query when repo is omitted and unwraps the envelope", async () => {
    const fetchMock = stubFetch({ agents: fixture });

    const result = await listAgents();

    expect(fetchMock).toHaveBeenCalledWith("/api/agents");
    expect(result).toEqual(fixture);
  });

  it("appends an encoded ?repo= when a repo is given", async () => {
    const fetchMock = stubFetch({ agents: fixture });

    await listAgents("my org/repo name+extra");

    expect(fetchMock).toHaveBeenCalledWith("/api/agents?repo=my%20org%2Frepo%20name%2Bextra");
  });
});

describe("listCollaborators", () => {
  const fixture: CollaboratorSummary[] = [
    {
      login: "octocat",
      pullsAuthored: 4,
      reviewsReceived: 6,
      verdicts: { approve: 4, "request-changes": 2 },
      agentsSeen: 2,
      lastActivityAt: "2026-01-05T00:00:00Z",
    },
  ];

  it("fetches /api/collaborators with no query when repo is omitted and unwraps the envelope", async () => {
    const fetchMock = stubFetch({ collaborators: fixture });

    const result = await listCollaborators();

    expect(fetchMock).toHaveBeenCalledWith("/api/collaborators");
    expect(result).toEqual(fixture);
  });

  it("appends an encoded ?repo= when a repo is given", async () => {
    const fetchMock = stubFetch({ collaborators: fixture });

    await listCollaborators("acme/widgets");

    expect(fetchMock).toHaveBeenCalledWith("/api/collaborators?repo=acme%2Fwidgets");
  });
});

describe("error handling", () => {
  it("throws an Error carrying the status code when the response is not ok", async () => {
    stubFetch({ error: "boom" }, false, 500);

    await expect(getOverview()).rejects.toThrow("500");
  });
});
