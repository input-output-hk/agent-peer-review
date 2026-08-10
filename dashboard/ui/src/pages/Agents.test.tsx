import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { Agents } from "./Agents";
import * as api from "../api";
import type { AgentSummary, RepoSummary } from "../types";

vi.mock("../api");

const known: AgentSummary = {
  agent: "claude-code",
  model: "claude-opus-4-8",
  reviews: 9,
  primaries: 6,
  enrichments: 3,
  verdicts: { approve: 5, "request-changes": 1, agree: 3 },
  agreement: { agree: 3, disagree: 0, mixed: 0 },
  avgTurnaroundSeconds: 125,
  lastActiveAt: "2026-01-05T00:00:00Z",
  repos: 4,
};

const unknown: AgentSummary = {
  agent: null,
  model: null,
  reviews: 2,
  primaries: 2,
  enrichments: 0,
  verdicts: { comment: 2 },
  agreement: null,
  avgTurnaroundSeconds: null,
  lastActiveAt: "2026-01-04T00:00:00Z",
  repos: 1,
};

const repos: RepoSummary[] = [{ owner: "acme", name: "widgets", pulls: 4 }];

describe("Agents", () => {
  beforeEach(() => {
    // Clear first: mock call history is not reset between tests by default, and the filter test
    // below asserts on call ORDINALS, which would otherwise count calls made by earlier tests.
    vi.clearAllMocks();
    vi.mocked(api.listRepos).mockResolvedValue(repos);
  });

  it("renders a known identity with its review/primary/enrichment/repo counts and turnaround", async () => {
    vi.mocked(api.listAgents).mockResolvedValue([known, unknown]);

    render(<Agents />);

    const row = (await screen.findByText("claude-code (claude-opus-4-8)")).closest("tr");
    expect(row).not.toBeNull();
    const cells = within(row!).getAllByRole("cell");
    expect(cells[1]).toHaveTextContent("9"); // reviews
    expect(cells[2]).toHaveTextContent("6"); // primaries
    expect(cells[3]).toHaveTextContent("3"); // enrichments
    expect(cells[6]).toHaveTextContent("2m 5s"); // avg turnaround
    expect(cells[8]).toHaveTextContent("4"); // repos
  });

  it("renders the (null, null) row as Unknown with a muted metadata note", async () => {
    vi.mocked(api.listAgents).mockResolvedValue([known, unknown]);

    render(<Agents />);

    const row = (await screen.findByText("Unknown")).closest("tr");
    expect(row).toHaveTextContent(/without captured agent\/model metadata/i);
    const cells = within(row!).getAllByRole("cell");
    expect(cells[6]).toHaveTextContent("n/a"); // avg turnaround, no claim sample
  });

  it("renders the agreement breakdown only when non-null", async () => {
    vi.mocked(api.listAgents).mockResolvedValue([known, unknown]);

    render(<Agents />);

    const knownRow = (await screen.findByText("claude-code (claude-opus-4-8)")).closest("tr");
    // Scoped to the agreement cell: "Agree" also appears in the verdicts cell for this identity
    // (its verdicts include an `agree` bucket), so an unscoped query matches two elements.
    const agreementCell = within(knownRow!).getAllByRole("cell")[5]!;
    expect(within(agreementCell).getByText("Agree")).toBeInTheDocument();
    expect(within(agreementCell).getByText("3")).toBeInTheDocument();

    const unknownRow = screen.getByText("Unknown").closest("tr");
    expect(within(unknownRow!).getByText("No second opinions yet.")).toBeInTheDocument();
  });

  it("shows an inline error box when the agents fetch fails", async () => {
    vi.mocked(api.listAgents).mockRejectedValue(new Error("network down"));

    render(<Agents />);

    expect(await screen.findByRole("alert")).toHaveTextContent("network down");
  });

  it("shows \"No reviews synced yet.\" when there are no agents", async () => {
    vi.mocked(api.listAgents).mockResolvedValue([]);

    render(<Agents />);

    expect(await screen.findByText("No reviews synced yet.")).toBeInTheDocument();
  });

  it("omits the repo param for the initial load and refetches with the selected repo when the filter changes", async () => {
    vi.mocked(api.listAgents).mockResolvedValue([]);

    render(<Agents />);
    await screen.findByText("No reviews synced yet.");
    expect(api.listAgents).toHaveBeenNthCalledWith(1, undefined);

    const select = await screen.findByRole("combobox");
    // Wait for the repo options to arrive: the filter's option list comes from listRepos(), and
    // firing a change for a value that has no matching <option> yet leaves the select empty.
    await screen.findByRole("option", { name: "acme/widgets" });
    fireEvent.change(select, { target: { value: "acme/widgets" } });

    await waitFor(() => expect(api.listAgents).toHaveBeenNthCalledWith(2, "acme/widgets"));
  });
});
