import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { RepoPulls } from "./RepoPulls";
import * as api from "../api";
import type { PullSummary } from "../types";

vi.mock("../api");

const pull: PullSummary = {
  number: 7,
  title: "Add rate limiting",
  author: "octocat",
  state: "open",
  url: "https://github.com/acme/widgets/pull/7",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-05T00:00:00Z",
  mergedAt: null,
  reviews: 2,
  primaryVerdict: "request-changes",
};

describe("RepoPulls", () => {
  it("renders a seeded pull with its verdict label and a link to the detail route", async () => {
    vi.mocked(api.listPulls).mockResolvedValue([pull]);

    render(<RepoPulls owner="acme" name="widgets" />);

    const link = await screen.findByRole("link", { name: "#7" });
    expect(link).toHaveAttribute("href", "/repos/acme/widgets/pulls/7");

    const row = link.closest("tr");
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent("Add rate limiting");
    expect(row).toHaveTextContent("octocat");
    expect(row).toHaveTextContent("Request changes");
    expect(row).toHaveTextContent("2026-01-05");

    // Scope the review-count assertion to the Reviews cell (column index 5) so it does not
    // accidentally match the "2" inside the updated date.
    const cells = within(row!).getAllByRole("cell");
    expect(cells[5]).toHaveTextContent("2");
  });

  it("shows an inline error box when the pulls fetch fails", async () => {
    vi.mocked(api.listPulls).mockRejectedValue(new Error("network down"));

    render(<RepoPulls owner="acme" name="widgets" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("network down");
  });

  it("shows an empty-state message when the repository has no pulls", async () => {
    vi.mocked(api.listPulls).mockResolvedValue([]);

    render(<RepoPulls owner="acme" name="widgets" />);

    expect(await screen.findByText("No pull requests synced yet.")).toBeInTheDocument();
  });
});
