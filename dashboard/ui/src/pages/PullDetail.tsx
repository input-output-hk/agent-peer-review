/**
 * One pull request in detail: fetches `/api/repos/:owner/:name/pulls/:number` and renders the
 * pull header, its participants, each review (primary first, then second opinions), and the
 * inline notes.
 *
 * Note bodies are untrusted text (posted on GitHub), so like review summaries they are rendered
 * ONLY through `renderMarkdown` + `dangerouslySetInnerHTML`; everything else is React-escaped.
 */
import { useEffect, useState } from "react";
import { getPullDetail } from "../api";
import type { PullDetail as PullDetailData } from "../types";
import { shortDate, verdictLabel } from "../format";
import { renderMarkdown } from "../markdown";
import { ReviewCard } from "../components/ReviewCard";

export interface PullDetailProps {
  owner: string;
  name: string;
  number: number;
}

type PullDetailState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: PullDetailData };

export function PullDetail({ owner, name, number }: PullDetailProps) {
  const [state, setState] = useState<PullDetailState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    getPullDetail(owner, name, number)
      .then((data) => {
        if (!cancelled) setState({ status: "ready", data });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : "Failed to load the pull request.";
          setState({ status: "error", message });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [owner, name, number]);

  if (state.status === "loading") {
    return <p>Loading pull request...</p>;
  }

  if (state.status === "error") {
    return (
      <div className="card" role="alert">
        <p style={{ margin: 0 }}>Failed to load the pull request: {state.message}</p>
      </div>
    );
  }

  const { pull, reviews, notes, participants } = state.data;
  const drifted = reviews.some((review) => review.drifted === true);
  const orderedReviews = [...reviews].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div className="card">
        <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>{pull.title}</h2>
          {drifted ? (
            <span
              style={{
                color: "var(--danger)",
                border: "1px solid var(--danger)",
                borderRadius: 999,
                padding: "0.1rem 0.5rem",
                fontSize: "0.75rem",
                fontWeight: 700,
              }}
            >
              Drift detected
            </span>
          ) : null}
        </div>
        <p style={{ margin: "0.25rem 0 0", color: "var(--muted)", fontSize: "0.875rem" }}>
          {["#" + pull.number, pull.author, pull.state, verdictLabel(pull.primaryVerdict)].join(" · ")}
        </p>
        <p style={{ margin: "0.25rem 0 0", color: "var(--muted)", fontSize: "0.875rem" }}>
          opened {shortDate(pull.createdAt)}, updated {shortDate(pull.updatedAt)}
          {pull.mergedAt !== null ? `, merged ${shortDate(pull.mergedAt)}` : ""}
        </p>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Participants</h3>
        {participants.length === 0 ? (
          <p style={{ margin: 0, color: "var(--muted)" }}>No participants recorded.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
            {participants.map((participant) => (
              <li key={participant.login}>
                {participant.login} <span style={{ color: "var(--muted)" }}>({participant.role})</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {orderedReviews.length === 0 ? (
        <p style={{ color: "var(--muted)" }}>No reviews recorded yet.</p>
      ) : (
        orderedReviews.map((review) => <ReviewCard key={review.githubReviewId} review={review} />)
      )}

      {notes.length > 0 ? (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Notes</h3>
          {notes.map((note, index) => (
            <div key={`${note.path}-${index}`} style={{ marginTop: index === 0 ? 0 : "0.75rem" }}>
              <p style={{ margin: 0, color: "var(--muted)", fontSize: "0.875rem" }}>
                <code>{note.line !== null ? `${note.path}:${note.line}` : note.path}</code> {note.author}
              </p>
              <div dangerouslySetInnerHTML={{ __html: renderMarkdown(note.body) }} />
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
