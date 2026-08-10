/** Pure display formatters for the dashboard UI. No React, no fetching. */

/** Compact `YYYY-MM-DD` from an ISO timestamp, or "unknown" for null/invalid input. */
export function shortDate(iso: string | null): string {
  if (iso === null) return "unknown";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "unknown";
  return iso.slice(0, 10);
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** Human duration between a claim and the review submission, e.g. "2h 5m" or "3m". Null when unclaimed or unparsable. */
export function turnaround(claimedAt: string | null, submittedAt: string): string | null {
  if (claimedAt === null) return null;
  const start = new Date(claimedAt).getTime();
  const end = new Date(submittedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;

  const totalMinutes = Math.round(Math.max(0, end - start) / MINUTE_MS);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

const MINUTE_S = 60;
const HOUR_S = 60 * MINUTE_S;

/**
 * Humanizes a duration given directly in seconds, e.g. "2h 5m" or "45s". Used for the agents
 * table's averaged turnaround, which -- unlike a single review's `claimedAt`/`submittedAt`
 * pair -- has no two timestamps to run through `turnaround`, only their averaged gap. "n/a"
 * when there is no sample to average (no review in the identity's history carries a claim).
 */
export function humanizeDuration(seconds: number | null): string {
  if (seconds === null) return "n/a";
  const total = Math.round(Math.max(0, seconds));
  const hours = Math.floor(total / HOUR_S);
  const minutes = Math.floor((total % HOUR_S) / MINUTE_S);
  const secs = total % MINUTE_S;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

const VERDICT_LABELS: Record<string, string> = {
  approve: "Approve",
  "request-changes": "Request changes",
  comment: "Comment",
  agree: "Agree",
  disagree: "Disagree",
  mixed: "Mixed",
};

/** Title-cased verdict label from the fixed vocabulary, or "Unknown" for null. */
export function verdictLabel(v: string | null): string {
  if (v === null) return "Unknown";
  if (v in VERDICT_LABELS) return VERDICT_LABELS[v];
  const spaced = v.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const VERDICT_COLORS: Record<string, string> = {
  approve: "var(--success)",
  agree: "var(--success)",
  "request-changes": "var(--danger)",
  disagree: "var(--danger)",
  comment: "var(--warning)",
  mixed: "var(--warning)",
};

/**
 * Semantic color token for a verdict: approve/agree -> success, request-changes/disagree ->
 * danger, comment/mixed -> warning. Null (no verdict) and any string outside this fixed
 * vocabulary fall back to --muted rather than guessing a meaning -- verdict is body-attested
 * free text that anyone who can post a review body can set to anything (see queries.ts's
 * listAgents JSDoc), not a validated enum.
 */
export function verdictColor(v: string | null): string {
  if (v === null) return "var(--muted)";
  // Object.hasOwn, not a bare `VERDICT_COLORS[v] ?? ...`: a verdict literally named "__proto__"
  // (or "constructor", "toString", ...) would otherwise resolve to an inherited Object.prototype
  // member instead of undefined, so the fallback would not fire and a non-color value would reach
  // the style attribute. Verdict strings are body-attested free text, so those names are reachable.
  return Object.hasOwn(VERDICT_COLORS, v) ? VERDICT_COLORS[v]! : "var(--muted)";
}

const SECOND_MS = 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

const UNITS: Array<{ limit: number; unitMs: number; label: string }> = [
  { limit: MINUTE_MS, unitMs: SECOND_MS, label: "second" },
  { limit: HOUR_MS, unitMs: MINUTE_MS, label: "minute" },
  { limit: DAY_MS, unitMs: HOUR_MS, label: "hour" },
  { limit: WEEK_MS, unitMs: DAY_MS, label: "day" },
  { limit: MONTH_MS, unitMs: WEEK_MS, label: "week" },
  { limit: YEAR_MS, unitMs: MONTH_MS, label: "month" },
  { limit: Infinity, unitMs: YEAR_MS, label: "year" },
];

/** Coarse relative time like "3 days ago" (or "in 3 days" for a future timestamp). `now` defaults to the real clock but can be fixed for tests. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";

  const diffMs = now.getTime() - then;
  const absMs = Math.abs(diffMs);
  const unit = UNITS.find((u) => absMs < u.limit) ?? UNITS[UNITS.length - 1];
  const value = Math.round(absMs / unit.unitMs);

  if (value === 0) return "just now";
  const plural = value === 1 ? unit.label : `${unit.label}s`;
  return diffMs < 0 ? `in ${value} ${plural}` : `${value} ${plural} ago`;
}
