/**
 * One review rendered as a card: its role and verdict, the agent/model metadata that
 * produced it, an optional turnaround time, and the review summary.
 *
 * The summary is untrusted text (it comes from a review body posted on GitHub), so it is
 * rendered ONLY through `renderMarkdown` + `dangerouslySetInnerHTML`, never as raw HTML any
 * other way. `renderMarkdown` escapes embedded HTML and runs DOMPurify over the result.
 */
import type { ReviewDetail } from "../types";
import { verdictLabel, turnaround } from "../format";
import { renderMarkdown } from "../markdown";

export interface ReviewCardProps {
  review: ReviewDetail;
}

export function ReviewCard({ review }: ReviewCardProps) {
  const roleLabel = review.role ?? (review.isPrimary ? "primary" : "second opinion");
  const meta = [review.model, review.agent, review.toolVersion, review.machine].filter(
    (value): value is string => value !== null && value !== "",
  );
  const elapsed = turnaround(review.claimedAt, review.submittedAt);

  return (
    <div className="card">
      <h3 style={{ margin: 0 }}>
        {roleLabel}: {verdictLabel(review.verdict)}
      </h3>
      <p style={{ margin: "0.25rem 0 0", color: "var(--muted)", fontSize: "0.875rem" }}>
        {["by " + review.author, ...meta, elapsed !== null ? `turnaround ${elapsed}` : null]
          .filter((part): part is string => part !== null)
          .join(" · ")}
      </p>
      <div
        style={{ marginTop: "0.75rem" }}
        dangerouslySetInnerHTML={{ __html: renderMarkdown(review.summary) }}
      />
    </div>
  );
}
