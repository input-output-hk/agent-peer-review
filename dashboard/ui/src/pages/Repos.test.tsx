import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Repos } from "./Repos";
import * as api from "../api";
import type { RepoSummary } from "../types";

vi.mock("../api");

describe("Repos", () => {
  it("renders each repo with its pull count and a link to its pulls route", async () => {
    const fixture: RepoSummary[] = [
      { owner: "acme", name: "widgets", pulls: 4 },
      { owner: "my-org", name: "svc", pulls: 12 },
    ];
    vi.mocked(api.listRepos).mockResolvedValue(fixture);

    render(<Repos />);

    const firstLink = await screen.findByRole("link", { name: "acme/widgets" });
    expect(firstLink).toHaveAttribute("href", "/repos/acme/widgets");
    expect(firstLink.closest("tr")).toHaveTextContent("4");

    const secondLink = screen.getByRole("link", { name: "my-org/svc" });
    expect(secondLink).toHaveAttribute("href", "/repos/my-org/svc");
    expect(secondLink.closest("tr")).toHaveTextContent("12");
  });

  it("shows an inline error box when the repos fetch fails", async () => {
    vi.mocked(api.listRepos).mockRejectedValue(new Error("network down"));

    render(<Repos />);

    expect(await screen.findByRole("alert")).toHaveTextContent("network down");
  });

  it("shows \"No repositories synced yet.\" when there are no repos", async () => {
    vi.mocked(api.listRepos).mockResolvedValue([]);

    render(<Repos />);

    expect(await screen.findByText("No repositories synced yet.")).toBeInTheDocument();
  });
});
