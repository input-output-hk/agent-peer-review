// Turn the map phase's combined output into one compact human summary.
//
// Input arrives on stdin in the shape the taskflow runtime produces for a map phase: one
// "### [k/N] <agent>" header per item, "(failed)" appended when that item failed, and the item's own
// output underneath. Each item is asked to end with a single JSON result line; anything else it
// printed is ignored.
//
// Zero dependencies, and all string handling is linear (indexOf / slice / startsWith / endsWith /
// split): the text below is written by a model reading pull-request content, so no regex is applied
// to it.

import { readFileSync } from "node:fs";

const ITEM_HEADER = "### [";
const FAILED_SUFFIX = "(failed)";
const MAX_NOTES = 20;
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

function main() {
  const items = parseItems(readStdin());

  if (items.length === 0) {
    process.stdout.write("pr-requester: no candidate pull requests.\n");
    return;
  }

  const counts = { stabilized: 0, proposed: 0, merged: 0, "review-requested": 0, escalated: 0, failed: 0 };
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

    if (stabilize === "updated") counts.stabilized += 1;
    if (expedite === "proposed" || expedite === "already-proposed") counts.proposed += 1;
    if (expedite === "merged") counts.merged += 1;
    if (requested === "requested" || requested === "already-requested") counts["review-requested"] += 1;

    // Every item that stopped early gets a line, so a pull request the flow walked away from is
    // never invisible in the summary. "blocked" is deliberately absent: it does not stop an item.
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
      attention.push(`${label(item)}: the merge was refused`);
    }
  }

  const line = Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(" ");
  process.stdout.write(`pr-requester: ${items.length} pull request(s). ${line}\n`);
  for (const note of attention.slice(0, MAX_NOTES)) process.stdout.write(`- ${note}\n`);
  if (attention.length > MAX_NOTES) process.stdout.write(`- and ${attention.length - MAX_NOTES} more\n`);
}

main();
