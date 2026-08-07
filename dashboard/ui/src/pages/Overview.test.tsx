import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Overview } from "./Overview";
import * as api from "../api";
import type { Overview as OverviewData } from "../types";

vi.mock("../api");

const fixture: OverviewData = {
  totals: { repos: 3, pulls: 11, reviews: 27 },
  verdicts: [
    { verdict: "approve", count: 15 },
    { verdict: "request-changes", count: 8 },
    { verdict: "comment", count: 4 },
  ],
  models: [
    { model: "claude-opus-4-8", count: 19 },
    { model: "gpt-5", count: 8 },
  ],
  activity: [
    { day: "2026-01-01", count: 2 },
    { day: "2026-01-02", count: 5 },
    { day: "2026-01-03", count: 3 },
  ],
  lastSync: {
    startedAt: "2026-01-03T10:00:00Z",
    finishedAt: "2026-01-03T10:05:00Z",
    ok: true,
    counts: { pulls: 11, reviews: 27 },
  },
};

const emptyFixture: OverviewData = {
  totals: { repos: 1, pulls: 0, reviews: 0 },
  verdicts: [],
  models: [],
  activity: [],
  lastSync: {
    startedAt: "2026-01-04T00:00:00Z",
    finishedAt: "2026-01-04T00:01:00Z",
    ok: false,
    counts: {},
  },
};

describe("Overview", () => {
  it("shows the stat tiles, verdict bar list, model bar list, activity chart, and last sync banner once the overview loads", async () => {
    vi.mocked(api.getOverview).mockResolvedValue(fixture);

    render(<Overview />);

    const reposLabel = await screen.findByText("Repos");
    expect(reposLabel.closest(".card")).toHaveTextContent("3");
    expect(screen.getByText("Pulls").closest(".card")).toHaveTextContent("11");
    expect(screen.getByText("Reviews").closest(".card")).toHaveTextContent("27");

    expect(screen.getByRole("img", { name: "Verdicts" })).toBeInTheDocument();
    expect(screen.getByText("Approve")).toBeInTheDocument();
    expect(screen.getByText("Request changes")).toBeInTheDocument();

    expect(screen.getByRole("img", { name: "Models" })).toBeInTheDocument();
    expect(screen.getByText("claude-opus-4-8")).toBeInTheDocument();

    expect(screen.getByRole("img", { name: "Reviews per day" })).toBeInTheDocument();

    expect(screen.getByText("Succeeded")).toBeInTheDocument();
  });

  it("shows an inline error box when the overview fetch fails", async () => {
    vi.mocked(api.getOverview).mockRejectedValue(new Error("network down"));

    render(<Overview />);

    expect(await screen.findByRole("alert")).toHaveTextContent("network down");
  });

  it("shows the empty-state text for both bar lists and the activity chart, and the failed status for a failed sync", async () => {
    vi.mocked(api.getOverview).mockResolvedValue(emptyFixture);

    render(<Overview />);

    expect(await screen.findByText("Failed")).toBeInTheDocument();
    expect(screen.getAllByText("No data yet.")).toHaveLength(2);
    expect(screen.getByText("No activity yet.")).toBeInTheDocument();
  });

  it("shows \"No sync recorded yet.\" when lastSync is null", async () => {
    vi.mocked(api.getOverview).mockResolvedValue({ ...emptyFixture, lastSync: null });

    render(<Overview />);

    expect(await screen.findByText("No sync recorded yet.")).toBeInTheDocument();
  });
});
