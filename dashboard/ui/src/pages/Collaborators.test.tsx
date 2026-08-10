import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { Collaborators } from "./Collaborators";
import * as api from "../api";
import type { CollaboratorSummary, RepoSummary } from "../types";

vi.mock("../api");

const alice: CollaboratorSummary = {
  login: "alice",
  pullsAuthored: 3,
  reviewsReceived: 7,
  verdicts: { approve: 5, "request-changes": 2 },
  agentsSeen: 2,
  lastActivityAt: "2026-01-06T00:00:00Z",
};

const bob: CollaboratorSummary = {
  login: "bob",
  pullsAuthored: 1,
  reviewsReceived: 0,
  verdicts: {},
  agentsSeen: 0,
  lastActivityAt: "2026-01-02T00:00:00Z",
};

const repos: RepoSummary[] = [{ owner: "acme", name: "widgets", pulls: 4 }];

describe("Collaborators", () => {
  beforeEach(() => {
    // Clear first: mock call history is not reset between tests by default, and the filter test
    // below asserts on call ORDINALS, which would otherwise count calls made by earlier tests.
    vi.clearAllMocks();
    vi.mocked(api.listRepos).mockResolvedValue(repos);
  });

  it("renders a row per collaborator with its counts", async () => {
    vi.mocked(api.listCollaborators).mockResolvedValue([alice, bob]);

    render(<Collaborators />);

    const aliceRow = (await screen.findByText("alice")).closest("tr")!;
    expect(within(aliceRow).getByText("3")).toBeInTheDocument(); // pulls authored
    expect(within(aliceRow).getByText("7")).toBeInTheDocument(); // reviews received
    // The verdict distribution renders its buckets as labeled bars with raw counts.
    expect(within(aliceRow).getByText("5")).toBeInTheDocument();

    const bobRow = screen.getByText("bob").closest("tr")!;
    // A collaborator whose pulls carry no reviews shows the empty-distribution text, not a bar.
    expect(within(bobRow).getByText("No verdicts yet.")).toBeInTheDocument();
  });

  it("labels last activity as belonging to the pull requests, not the person", async () => {
    vi.mocked(api.listCollaborators).mockResolvedValue([alice]);

    render(<Collaborators />);
    await screen.findByText("alice");

    // The API folds the pull's own updatedAt into this value, and GitHub bumps that on anyone's
    // activity, so the column must not claim it is the collaborator's own last action.
    const header = screen.getByText("Last activity");
    expect(header.getAttribute("title")).toContain("any of their pull requests");
  });

  it("shows an empty state rather than an empty table", async () => {
    vi.mocked(api.listCollaborators).mockResolvedValue([]);

    render(<Collaborators />);
    expect(await screen.findByText("No collaborators synced yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders an inline error box when the fetch fails", async () => {
    vi.mocked(api.listCollaborators).mockRejectedValue(new Error("boom"));

    render(<Collaborators />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("boom");
  });

  it("refetches scoped to the repo chosen in the filter, and omits the param for all repositories", async () => {
    vi.mocked(api.listCollaborators).mockResolvedValue([]);

    render(<Collaborators />);
    await screen.findByText("No collaborators synced yet.");
    expect(api.listCollaborators).toHaveBeenNthCalledWith(1, undefined);

    const select = await screen.findByRole("combobox");
    // Wait for the repo options to arrive: the filter's option list comes from listRepos(), and
    // firing a change for a value that has no matching <option> yet leaves the select empty.
    await screen.findByRole("option", { name: "acme/widgets" });
    fireEvent.change(select, { target: { value: "acme/widgets" } });
    await waitFor(() => expect(api.listCollaborators).toHaveBeenNthCalledWith(2, "acme/widgets"));

    // Selecting "All repositories" again must go back to omitting the param entirely.
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() => expect(api.listCollaborators).toHaveBeenNthCalledWith(3, undefined));
  });
});
