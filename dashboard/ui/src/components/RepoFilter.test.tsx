import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RepoFilter } from "./RepoFilter";
import type { RepoSummary } from "../types";

const repos: RepoSummary[] = [
  { owner: "acme", name: "widgets", pulls: 4 },
  { owner: "my-org", name: "svc", pulls: 12 },
];

describe("RepoFilter", () => {
  it("renders an \"All repositories\" option plus one option per repo", () => {
    render(<RepoFilter repos={repos} value={undefined} onChange={() => {}} />);

    const options = screen.getAllByRole("option").map((option) => option.textContent);
    expect(options).toEqual(["All repositories", "acme/widgets", "my-org/svc"]);
  });

  it("selects the option matching the current value", () => {
    render(<RepoFilter repos={repos} value="my-org/svc" onChange={() => {}} />);

    expect(screen.getByRole("combobox")).toHaveValue("my-org/svc");
  });

  it("fires onChange with the selected repo string", () => {
    const onChange = vi.fn();
    render(<RepoFilter repos={repos} value={undefined} onChange={onChange} />);

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "acme/widgets" } });

    expect(onChange).toHaveBeenCalledWith("acme/widgets");
  });

  it("fires onChange with undefined when switching back to \"All repositories\"", () => {
    const onChange = vi.fn();
    render(<RepoFilter repos={repos} value="acme/widgets" onChange={onChange} />);

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });

    expect(onChange).toHaveBeenCalledWith(undefined);
  });
});
