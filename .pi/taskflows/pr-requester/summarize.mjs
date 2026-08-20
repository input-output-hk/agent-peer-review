// Turn the map phase's combined output into one compact human summary.
//
// Input arrives on stdin in the shape the taskflow runtime produces for a map phase: one
// "### [k/N] <agent>" header per item, "(failed)" appended when that item failed, and the item's own
// output underneath. Each item is asked to end with a single JSON result line; anything else it
// printed is ignored.
//
// Zero dependencies, and all string handling is linear (indexOf / slice / startsWith / endsWith /
// split / toLowerCase): the text below is written by a model reading pull-request content, so no
// regex is applied to it.

import { readFileSync } from "node:fs";

const ITEM_HEADER = "### [";
const FAILED_SUFFIX = "(failed)";
const MAX_NOTES = 20;
const MAX_DIGITS = 6;
const MAX_REASON_CHARS = 160;

/** Read all of stdin. An empty or closed stdin means the map phase produced nothing. */
function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function isDigits(text) {
  if (text.length === 0 || text.length > MAX_DIGITS) return false;
  for (const ch of text) if (ch < "0" || ch > "9") return false;
  return true;
}

/**
 * The "k/N" position out of a runtime item header, or null when the header is not shaped that way.
 *
 * This is what makes a failed item identifiable: an item that never printed a result line has no
 * repository or number to name it by, and its position in the fan-out is the only handle left.
 */
function parsePosition(trimmed) {
  const open = ITEM_HEADER.length;
  const slash = trimmed.indexOf("/", open);
  if (slash === -1) return null;
  const close = trimmed.indexOf("]", slash);
  if (close === -1) return null;
  const index = trimmed.slice(open, slash);
  const total = trimmed.slice(slash + 1, close);
  return isDigits(index) && isDigits(total) ? { index, total } : null;
}

/**
 * Split the combined output into per-item records.
 *
 * A record is `{ failed, position, result }`, where `result` is the last JSON object the item
 * printed, or null when it printed none. An item with no parseable result counts as a failure: the
 * flow cannot tell what it did.
 */
function parseItems(text) {
  const items = [];
  let current = null;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith(ITEM_HEADER)) {
      if (current !== null) items.push(current);
      current = { failed: trimmed.endsWith(FAILED_SUFFIX), position: parsePosition(trimmed), result: null };
      continue;
    }
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      // An unlabeled block still counts: a single-item run may arrive without a header.
      if (current === null) current = { failed: false, position: null, result: null };
      current.result = parsed;
    }
  }
  if (current !== null) items.push(current);
  return items;
}

/** Name an item as precisely as its own output allows, falling back to its position in the fan-out. */
function label(item) {
  const result = item.result;
  const repo = result !== null && typeof result.repo === "string" ? result.repo : "";
  const number = result !== null && typeof result.number === "number" ? result.number : 0;
  if (repo && number > 0) return `${repo} #${number}`;
  if (repo) return repo;
  if (item.position !== null) return `item ${item.position.index} of ${item.position.total}`;
  return "an unidentified item";
}

/** First reason, trimmed to one readable line. Reasons quote file and package names from the diff. */
function firstReason(result) {
  const reasons = result !== null && Array.isArray(result.reasons) ? result.reasons : [];
  for (const reason of reasons) {
    if (typeof reason !== "string" || reason.length === 0) continue;
    const oneLine = reason.split("\n").join(" ");
    return oneLine.length > MAX_REASON_CHARS ? `${oneLine.slice(0, MAX_REASON_CHARS)}...` : oneLine;
  }
  return "";
}

/**
 * True when a reason says the decision is held by a review that is in flight.
 *
 * Matched on the two words that carry the meaning rather than on a whole sentence, because the gate
 * owns the wording of its rails and this has to keep working when that wording changes. The rail is
 * worth singling out: it is the one refusal an operator can cause by configuration alone. A peer
 * agent missing from `knownAgentLogins` reads as a human, so its review holds the gate on a pull
 * request no human has touched, and a GitHub review is permanent, so the hold never expires.
 */
function heldForReviewInFlight(result) {
  const reasons = result !== null && Array.isArray(result.reasons) ? result.reasons : [];
  for (const reason of reasons) {
    if (typeof reason !== "string") continue;
    const lower = reason.toLowerCase();
    const inFlight = lower.indexOf("in flight") !== -1 || lower.indexOf("in-flight") !== -1;
    if (inFlight && lower.indexOf("review") !== -1) return true;
  }
  return false;
}

function main() {
  const items = parseItems(readStdin());

  if (items.length === 0) {
    process.stdout.write("pr-requester: no candidate pull requests.\n");
    return;
  }

  // "human-review-hold" is a breakdown of the refusals above it, not an outcome of its own: an item
  // counted there is also counted as proposed. It is called out because it is the one rail an
  // operator can trip by configuration, and a count is what turns that from silence into a number.
  const counts = {
    stabilized: 0,
    proposed: 0,
    merged: 0,
    "review-requested": 0,
    "human-review-hold": 0,
    escalated: 0,
    failed: 0,
  };
  const attention = [];

  for (const item of items) {
    const result = item.result;
    if (item.failed || result === null) {
      counts.failed += 1;
      attention.push(`${label(item)}: the agent did not report a result`);
      continue;
    }

    const stabilize = typeof result.stabilize === "string" ? result.stabilize : "";
    const expedite = typeof result.expedite === "string" ? result.expedite : "";
    const requested = typeof result.requested === "string" ? result.requested : "";
    const reason = firstReason(result);
    // Whether anybody is looking at this pull request now. `bot-authored` is not engagement, but it
    // is a hand-off to pr-steward rather than a strand, so it is excluded from the line below too.
    const engaged = requested === "requested" || requested === "already-requested";
    const held = heldForReviewInFlight(result);

    if (stabilize === "updated") counts.stabilized += 1;
    if (expedite === "proposed" || expedite === "already-proposed") counts.proposed += 1;
    if (expedite === "merged") counts.merged += 1;
    if (engaged) counts["review-requested"] += 1;
    if (held) counts["human-review-hold"] += 1;

    // Every item that stopped early gets a line, so a pull request the flow walked away from is
    // never invisible in the summary. "blocked" at stabilize is deliberately absent: it does not
    // stop an item. The four branches after the merge refusal are the ones a healthy-looking
    // summary used to hide (issue #51): the flow neither merged the pull request nor got anyone to
    // look at it, and only this list says so.
    if (expedite === "escalate-human") {
      counts.escalated += 1;
      attention.push(`${label(item)}: needs a human (stabilize reported ${stabilize || "nothing"})`);
    } else if (stabilize === "error" || expedite === "error" || requested === "error") {
      counts.failed += 1;
      attention.push(`${label(item)}: a tool call failed`);
    } else if (stabilize === "conflict") {
      counts.escalated += 1;
      attention.push(`${label(item)}: stopped at stabilize; only the author can resolve the conflict`);
    } else if (stabilize === "gone") {
      attention.push(`${label(item)}: stopped at stabilize; the pull request is closed or merged`);
    } else if (stabilize === "draft") {
      attention.push(`${label(item)}: stopped at stabilize; the pull request is a draft`);
    } else if (expedite === "blocked") {
      attention.push(`${label(item)}: the merge was refused${reason ? ` (${reason})` : ""}`);
    } else if (requested === "unconfigured") {
      // requestPeerReview throws before its first GitHub call, so nothing was written anywhere and
      // the pull request itself carries no trace. Naming the field and the variable is the whole
      // point: otherwise an operator reads review-requested=0 for a month and learns nothing.
      attention.push(
        `${label(item)}: no reviewers are configured, so nobody was asked; set "reviewers" in ~/.agent-peer-review/config.json or AGENT_REVIEW_REVIEWERS`,
      );
    } else if (expedite === "not-eligible") {
      attention.push(`${label(item)}: the gate never ran${reason ? ` (${reason})` : ""}`);
    } else if (held) {
      attention.push(`${label(item)}: held for a review in flight; if no human is looking, "knownAgentLogins" is missing a peer agent`);
    } else if ((expedite === "proposed" || expedite === "already-proposed") && !engaged && requested !== "bot-authored") {
      attention.push(`${label(item)}: proposed, and no reviewer was asked${reason ? ` (${reason})` : ""}`);
    }
  }

  const line = Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(" ");
  process.stdout.write(`pr-requester: ${items.length} pull request(s). ${line}\n`);
  for (const note of attention.slice(0, MAX_NOTES)) process.stdout.write(`- ${note}\n`);
  if (attention.length > MAX_NOTES) process.stdout.write(`- and ${attention.length - MAX_NOTES} more\n`);
}

main();
