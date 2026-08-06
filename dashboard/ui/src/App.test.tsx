import { it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "./App";

it("renders the dashboard heading", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: /agent peer review dashboard/i })).toBeInTheDocument();
});
