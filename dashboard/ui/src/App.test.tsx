import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "./App";
import * as api from "./api";
import type { Overview as OverviewData } from "./types";

vi.mock("./api");

const overview: OverviewData = {
  totals: { repos: 0, pulls: 0, reviews: 0 },
  verdicts: [],
  models: [],
  activity: [],
  lastSync: null,
};

describe("App shell", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/");
    vi.mocked(api.getOverview).mockResolvedValue(overview);
  });

  it("renders the routed shell (heading, nav, and theme toggle) at /", async () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: /agent peer review dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole("navigation")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Repositories" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /switch to (light|dark) theme/i })).toBeInTheDocument();

    // The overview page renders below the shell; wait for it so its async load settles.
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
  });
});
