import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PullDetail } from "./PullDetail";
import * as api from "../api";
import type { PullDetail as PullDetailData, ReviewDetail, Note } from "../types";

vi.mock("../api");

const primaryReview: ReviewDetail = {
  githubReviewId: 1001,
  author: "claude-review-bot",
  isPrimary: true,
  role: "primary",
  verdict: "approve",
  summary: "Looks solid to me.",
  commitId: "abc123",
  submittedAt: "2026-01-04T10:05:00Z",
  model: "claude-opus-4-8",
  agent: "claude-code",
  toolVersion: "0.4.0",
  machine: "ci-runner",
  claimedAt: "2026-01-04T10:00:00Z",
  drifted: false,
};

const note: Note = {
  path: "src/server.ts",
  line: 42,
  body: "Consider a guard here.",
  author: "claude-review-bot",
};

function makeDetail(overrides: { reviews?: ReviewDetail[]; notes?: Note[] } = {}): PullDetailData {
  return {
    pull: {
      number: 7,
      title: "Add rate limiting",
      author: "octocat",
      state: "open",
      url: "https://github.com/acme/widgets/pull/7",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-05T00:00:00Z",
      mergedAt: null,
      reviews: 1,
      primaryVerdict: "approve",
      headSha: "abc123",
      baseSha: "def456",
      repo: { owner: "acme", name: "widgets" },
    },
    reviews: overrides.reviews ?? [primaryReview],
    notes: overrides.notes ?? [note],
    claims: [],
    participants: [{ login: "octocat", role: "author" }],
  };
}

describe("PullDetail", () => {
  it("renders a review with its verdict, model, and summary text", async () => {
    vi.mocked(api.getPullDetail).mockResolvedValue(makeDetail());

    render(<PullDetail owner="acme" name="widgets" number={7} />);

    // The review card heading carries the verdict label (unique among headings).
    expect(await screen.findByRole("heading", { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByText(/claude-opus-4-8/)).toBeInTheDocument();
    expect(screen.getByText("Looks solid to me.")).toBeInTheDocument();
  });

  it("renders an inline note with its path:line location", async () => {
    vi.mocked(api.getPullDetail).mockResolvedValue(makeDetail());

    render(<PullDetail owner="acme" name="widgets" number={7} />);

    expect(await screen.findByText("src/server.ts:42")).toBeInTheDocument();
    expect(screen.getByText("Consider a guard here.")).toBeInTheDocument();
  });

  it("renders an untrusted review summary sanitized (no <script> node reaches the DOM)", async () => {
    const injected: ReviewDetail = { ...primaryReview, summary: "<script>alert(1)</script>" };
    vi.mocked(api.getPullDetail).mockResolvedValue(makeDetail({ reviews: [injected] }));

    const { container } = render(<PullDetail owner="acme" name="widgets" number={7} />);

    // Wait for the review to render, then assert no script element exists.
    await screen.findByRole("heading", { name: /approve/i });
    expect(container.querySelector("script")).toBeNull();
  });

  it("shows the drift badge when any review drifted", async () => {
    const drifted: ReviewDetail = { ...primaryReview, drifted: true };
    vi.mocked(api.getPullDetail).mockResolvedValue(makeDetail({ reviews: [drifted] }));

    render(<PullDetail owner="acme" name="widgets" number={7} />);

    expect(await screen.findByText("Drift detected")).toBeInTheDocument();
  });

  it("does not show the drift badge when no review drifted", async () => {
    vi.mocked(api.getPullDetail).mockResolvedValue(makeDetail());

    render(<PullDetail owner="acme" name="widgets" number={7} />);

    await screen.findByRole("heading", { name: /approve/i });
    expect(screen.queryByText("Drift detected")).not.toBeInTheDocument();
  });

  it("shows an inline error box when the detail fetch fails", async () => {
    vi.mocked(api.getPullDetail).mockRejectedValue(new Error("network down"));

    render(<PullDetail owner="acme" name="widgets" number={7} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("network down");
  });
});
