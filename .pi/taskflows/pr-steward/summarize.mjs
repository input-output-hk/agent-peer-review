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
const MAX_REASON_CHARS = 160;
const MAX_DIGITS = 6;

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
 * request no human has touched. The hold is an open review request, which clears natively when it is
 * answered, or a standing CHANGES_REQUESTED, which clears when that verdict is replaced; a login the
 * gate misreads as a human's supplies neither, so nothing arrives to clear it.
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
    process.stdout.write("pr-steward: no open bot dependency upgrades.\n");
    return;
  }

  // "approved" is counted apart from "approved-and-merged" on purpose: the approval landed and the
  // merge did not, so folding the two together would report an upgrade as shipped when it is only
  // unblocked.
  //
  // "human-review-hold" is a breakdown of the verdicts before it, not a verdict of its own: an item
  // counted there is also counted as proposed, approved, or blocked. It is called out because it is
  // the one rail an operator can trip by configuration, and a count is what turns that from silence
  // into a number (issue #51).
  const counts = {
    proposed: 0,
    approved: 0,
    "approved-and-merged": 0,
    "not-eligible": 0,
    blocked: 0,
    "human-review-hold": 0,
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

    const action = typeof result.action === "string" ? result.action : "";
    const reason = firstReason(result);
    const held = heldForReviewInFlight(result);
    if (held) counts["human-review-hold"] += 1;

    if (action === "proposed" || action === "already-proposed") counts.proposed += 1;
    else if (action === "approved") counts.approved += 1;
    else if (action === "approved-and-merged") counts["approved-and-merged"] += 1;
    else if (action === "not-eligible") counts["not-eligible"] += 1;
    else if (action === "blocked") counts.blocked += 1;
    else counts.failed += 1;

    if (action === "blocked") {
      attention.push(`${label(item)}: the merge was refused${reason ? ` (${reason})` : ""}`);
    } else if (action === "approved") {
      attention.push(`${label(item)}: approved, not merged${reason ? ` (${reason})` : ""}`);
    } else if (action === "not-eligible") {
      // A hand-off, not a failure: a major bump, an unreadable version, or a diff that is not
      // version-only is exactly what this path is supposed to leave to a person. But it writes
      // nothing at all on the pull request, so without a line here the hand-off is invisible and
      // permanent, and it lands on precisely the upgrades the flow exists for (issue #50).
      attention.push(`${label(item)}: not eligible for the automated path, so a human decides it${reason ? ` (${reason})` : ""}`);
    } else if (action === "" || action === "error") {
      attention.push(`${label(item)}: a tool call failed${reason ? ` (${reason})` : ""}`);
    } else if (held) {
      // Reached by a proposal, whose comment says the same thing on the pull request. The line is
      // here because the rail can be tripped by a peer agent missing from `knownAgentLogins`, and
      // then nothing about the wait is true: no human is looking, and none ever will.
      attention.push(`${label(item)}: held for a review in flight; if no human is looking, "knownAgentLogins" is missing a peer agent`);
    }
  }

  const line = Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(" ");
  process.stdout.write(`pr-steward: ${items.length} pull request(s). ${line}\n`);
  for (const note of attention.slice(0, MAX_NOTES)) process.stdout.write(`- ${note}\n`);
  if (attention.length > MAX_NOTES) process.stdout.write(`- and ${attention.length - MAX_NOTES} more\n`);
}

main();
