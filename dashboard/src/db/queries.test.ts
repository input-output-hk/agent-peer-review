import { describe, it, expect } from "vitest";
import { serializeMeta, PRIMARY_MARKER, type PullRequest, type Review } from "@input-output-hk/agent-review";
import { openDb } from "./open.js";
import { sync } from "../sync.js";
import { FakeSyncGateway } from "../testing/fake-gateway.js";
import { getOverview, listRepos, listPulls, getPullDetail, listSyncRuns, listAgents, listCollaborators } from "./queries.js";

const pull = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 7, title: "Add X", author: "alice", headSha: "head123", baseSha: "base123",
  url: "https://gh/pr/7", state: "merged", labels: ["ai-review"],
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", mergedAt: "2026-01-03T00:00:00Z", ...over,
});
const primary = (): Review => {
  const footer = serializeMeta({ v: 1, role: "primary", verdict: "approve", model: "claude-opus-4-8", agent: "claude-code" });
  return { id: 100, author: "agent-bot", state: "COMMENTED", body: `LGTM.\n\n${footer}\n\n${PRIMARY_MARKER}`, commitId: "head123", submittedAt: "2026-01-02T01:00:00Z" };
};

async function seeded() {
  const gw = new FakeSyncGateway();
  gw.seedPull("o/r", { pull: pull(), reviews: [primary()], notes: [{ id: 200, path: "a.ts", line: 5, body: "nit", author: "agent-bot" }] });
  const db = openDb(":memory:");
  await sync(gw, db, ["o/r"]);
  return db;
}

/** A review whose meta footer carries the given model (or omits `model` entirely when null). */
const reviewWithModel = (id: number, model: string | null): Review => {
  const footer = serializeMeta({ v: 1, role: "second-opinion", verdict: "agree", model: model ?? undefined });
  return { id, author: `bot${id}`, state: "COMMENTED", body: `Note.\n\n${footer}`, commitId: "head123", submittedAt: "2026-01-02T00:00:00Z" };
};

async function seededWithReviews(reviews: Review[]) {
  const gw = new FakeSyncGateway();
  gw.seedPull("o/r", { pull: pull(), reviews });
  const db = openDb(":memory:");
  await sync(gw, db, ["o/r"]);
  return db;
}

/**
 * A review whose body carries a full `agent-review:meta` footer, as `completeReview`/`enrichReview`
 * write with `captureMetadata` on. Primary-role reviews also get the PRIMARY_MARKER tag, matching
 * a genuine (non-superseded) completion; second-opinion reviews never carry it.
 */
const metaReview = (id: number, o: {
  author?: string; role: "primary" | "second-opinion"; verdict: string;
  model?: string; agent?: string; claimedAt?: string; submittedAt: string;
}): Review => {
  const footer = serializeMeta({ v: 1, role: o.role, verdict: o.verdict, model: o.model, agent: o.agent, claimedAt: o.claimedAt });
  const body = o.role === "primary" ? `Summary.\n\n${footer}\n\n${PRIMARY_MARKER}` : `Summary.\n\n${footer}`;
  return { id, author: o.author ?? "agent-bot", state: "COMMENTED", body, commitId: "head123", submittedAt: o.submittedAt };
};

/** A review with no meta footer and no primary marker: the capture-off / pre-Phase-0 fallback path
 *  that `deriveReviewFields` reads as `{ agent: null, model: null, role: "second-opinion", verdict: null }`. */
const plainReview = (id: number, o: { author?: string; submittedAt: string }): Review =>
  ({ id, author: o.author ?? "human1", state: "COMMENTED", body: "Looks fine to me.", commitId: "head123", submittedAt: o.submittedAt });

describe("queries", () => {
  it("getOverview totals, verdict split, model usage, last sync", async () => {
    const o = getOverview(await seeded());
    expect(o.totals).toEqual({ repos: 1, pulls: 1, reviews: 1 });
    expect(o.verdicts).toContainEqual({ verdict: "approve", count: 1 });
    expect(o.models).toContainEqual({ model: "claude-opus-4-8", count: 1 });
    expect(o.lastSync?.ok).toBe(true);
  });
  it("listRepos with pull counts", async () => {
    expect(listRepos(await seeded())).toEqual([{ owner: "o", name: "r", pulls: 1 }]);
  });
  it("listPulls with review count and primary verdict", async () => {
    const rows = listPulls(await seeded(), "o", "r");
    expect(rows[0]).toMatchObject({ number: 7, state: "merged", reviews: 1, primaryVerdict: "approve" });
  });
  it("getPullDetail assembles reviews, notes, participants", async () => {
    const d = getPullDetail(await seeded(), "o", "r", 7)!;
    expect(d.pull.number).toBe(7);
    expect(d.reviews[0]).toMatchObject({ role: "primary", verdict: "approve", model: "claude-opus-4-8" });
    expect(d.notes).toHaveLength(1);
    expect(d.participants.map((p) => p.login).sort()).toEqual(["agent-bot", "alice"]);
  });
  it("getPullDetail returns null for a missing pull", async () => {
    expect(getPullDetail(await seeded(), "o", "r", 999)).toBeNull();
  });
  it("listSyncRuns parses counts json", async () => {
    const runs = listSyncRuns(await seeded());
    expect(runs[0].counts.pulls).toBe(1);
    expect(runs[0].ok).toBe(true);
  });
  it("getOverview models merges NULL-model reviews into a single unknown row", async () => {
    const db = await seededWithReviews([
      reviewWithModel(301, null),
      reviewWithModel(302, null),
      reviewWithModel(303, "claude-opus-4-8"),
    ]);
    expect(getOverview(db).models).toEqual([
      { model: "unknown", count: 2 },
      { model: "claude-opus-4-8", count: 1 },
    ]);
  });
  it("getOverview models merges a literal 'unknown' model with a NULL model into one row", async () => {
    // The exact bug: GROUP BY on the raw `model` column puts NULL and the literal string
    // "unknown" in different SQL groups, even though both display as "unknown" after COALESCE.
    const db = await seededWithReviews([reviewWithModel(304, null), reviewWithModel(305, "unknown")]);
    expect(getOverview(db).models).toEqual([{ model: "unknown", count: 2 }]);
  });
  it("listRepos includes a repo with zero pulls", async () => {
    const gw = new FakeSyncGateway();
    gw.seedPull("o/r", { pull: pull(), reviews: [primary()] });
    const db = openDb(":memory:");
    await sync(gw, db, ["o/r", "o/empty"]);
    expect(listRepos(db)).toContainEqual({ owner: "o", name: "empty", pulls: 0 });
  });
  it("getPullDetail does not leak the internal db id", async () => {
    const d = getPullDetail(await seeded(), "o", "r", 7)!;
    expect("id" in d.pull).toBe(false);
  });
  it("getOverview and listSyncRuns report a failed sync_run with NULL counts", async () => {
    const db = openDb(":memory:");
    db.prepare(
      "INSERT INTO sync_run(started_at, finished_at, repos_json, counts_json, ok) VALUES(?,?,?,?,?)",
    ).run("2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z", JSON.stringify(["o/r"]), null, 0);
    const o = getOverview(db);
    expect(o.lastSync?.ok).toBe(false);
    expect(o.lastSync?.counts).toEqual({});
    const runs = listSyncRuns(db);
    expect(runs[0].ok).toBe(false);
    expect(runs[0].counts).toEqual({});
  });
});

describe("listAgents / listCollaborators", () => {
  /**
   * Two repos, four pulls, nine reviews, shaped to exercise every corner of both aggregates:
   * - "claude-code"/"opus" spans both repos (2 primaries + 1 in o/r2, 2 second-opinions), with a
   *   mix of claimed and unclaimed reviews (turnaround average over the claimed subset only).
   * - "other-bot"/"haiku" never has a claimedAt (avgTurnaroundSeconds and agreement both null).
   * - "carol-bot"/"mini" exists only in o/r2, so an o/r1 filter drops its row entirely.
   * - One metadata-less review (a plain human-looking comment) collapses into the (null, null)
   *   "unknown" identity.
   * - alice authors two pulls in o/r1 (collaborator aggregation across multiple pulls); bob's pull
   *   predates its own review (lastActivityAt must come from the review); carol's pull postdates
   *   its reviews (lastActivityAt must come from the pull).
   */
  async function seededForAgents() {
    const gw = new FakeSyncGateway();
    gw.seedPull("o/r1", {
      pull: pull({ number: 1, author: "alice", updatedAt: "2026-02-01T00:05:00Z" }),
      reviews: [
        metaReview(101, { role: "primary", verdict: "approve", model: "opus", agent: "claude-code", claimedAt: "2026-02-01T00:00:00Z", submittedAt: "2026-02-01T00:00:30Z" }),
        metaReview(102, { role: "second-opinion", verdict: "agree", model: "opus", agent: "claude-code", submittedAt: "2026-02-01T00:05:00Z" }),
        metaReview(103, { role: "second-opinion", verdict: "disagree", model: "opus", agent: "claude-code", claimedAt: "2026-02-01T00:10:00Z", submittedAt: "2026-02-01T00:11:00Z" }),
        plainReview(104, { submittedAt: "2026-02-01T00:12:00Z" }),
        metaReview(105, { role: "primary", verdict: "request-changes", model: "haiku", agent: "other-bot", submittedAt: "2026-02-01T00:13:00Z" }),
      ],
    });
    gw.seedPull("o/r1", {
      pull: pull({ number: 2, author: "alice", updatedAt: "2026-02-02T00:00:05Z" }),
      reviews: [
        metaReview(106, { role: "primary", verdict: "approve", model: "opus", agent: "claude-code", claimedAt: "2026-02-02T00:00:00Z", submittedAt: "2026-02-02T00:00:10Z" }),
      ],
    });
    gw.seedPull("o/r1", {
      pull: pull({ number: 3, author: "bob", updatedAt: "2026-01-01T00:00:00Z" }),
      reviews: [
        metaReview(107, { role: "primary", verdict: "approve", model: "haiku", agent: "other-bot", submittedAt: "2026-02-03T00:01:00Z" }),
      ],
    });
    gw.seedPull("o/r2", {
      pull: pull({ number: 1, author: "carol", updatedAt: "2026-02-10T00:00:00Z" }),
      reviews: [
        metaReview(108, { role: "primary", verdict: "approve", model: "mini", agent: "carol-bot", submittedAt: "2026-02-04T00:01:00Z" }),
        metaReview(109, { role: "primary", verdict: "approve", model: "opus", agent: "claude-code", submittedAt: "2026-02-05T00:00:00Z" }),
      ],
    });
    const db = openDb(":memory:");
    await sync(gw, db, ["o/r1", "o/r2"]);
    return db;
  }

  it("listAgents groups by (agent, model) identity, ordered by reviews desc then lastActiveAt desc", async () => {
    const rows = listAgents(await seededForAgents());
    expect(rows.map((r) => [r.agent, r.model])).toEqual([
      ["claude-code", "opus"], ["other-bot", "haiku"], ["carol-bot", "mini"], [null, null],
    ]);
  });

  it("listAgents splits primaries/enrichments by role, buckets verdicts, computes agreement and turnaround", async () => {
    const rows = listAgents(await seededForAgents());
    const cc = rows.find((r) => r.agent === "claude-code")!;
    expect(cc).toMatchObject({
      model: "opus", reviews: 5, primaries: 3, enrichments: 2,
      verdicts: { approve: 3, agree: 1, disagree: 1 },
      agreement: { agree: 1, disagree: 1, mixed: 0 },
      lastActiveAt: "2026-02-05T00:00:00Z", repos: 2,
    });
    // Turnaround averages only the 3 reviews with a claimedAt: 30s (101) + 60s (103) + 10s (106).
    // julianday() is a fractional-day float (SQLite's own precision limit is a few microseconds
    // per call, widening slightly across an average of three), so this checks closeness, not
    // exact equality; see the dedicated precision/skew tests below for the behavior that matters
    // (no systematic bias, negative gaps clamped to 0).
    expect(cc.avgTurnaroundSeconds).toBeCloseTo(100 / 3, 3);
  });

  it("listAgents leaves avgTurnaroundSeconds and agreement null when neither ever occurs for that identity", async () => {
    const rows = listAgents(await seededForAgents());
    const other = rows.find((r) => r.agent === "other-bot")!;
    expect(other).toMatchObject({ model: "haiku", reviews: 2, primaries: 2, enrichments: 0, avgTurnaroundSeconds: null, agreement: null, repos: 1 });
    expect(other.verdicts).toEqual({ "request-changes": 1, approve: 1 });
  });

  it("listAgents collapses metadata-less reviews into a single (null, null) unknown row", async () => {
    const rows = listAgents(await seededForAgents());
    const unknown = rows.find((r) => r.agent === null && r.model === null)!;
    expect(unknown).toMatchObject({ reviews: 1, primaries: 0, enrichments: 1, verdicts: {}, agreement: null, avgTurnaroundSeconds: null, repos: 1 });
  });

  it("listAgents treats agreement as verdict-based, not role-based", async () => {
    // A completeReview() that lost the primary race keeps role="second-opinion" but its ordinary
    // approve/request-changes/comment verdict (see core/operations/complete.ts's `competing`
    // branch), not an agree/disagree/mixed enrichment verdict. Agreement must not count it.
    const gw = new FakeSyncGateway();
    gw.seedPull("o/r", {
      pull: pull(),
      reviews: [metaReview(201, { role: "second-opinion", verdict: "approve", model: "opus", agent: "claude-code", submittedAt: "2026-01-02T00:00:00Z" })],
    });
    const db = openDb(":memory:");
    await sync(gw, db, ["o/r"]);
    const row = listAgents(db)[0];
    expect(row).toMatchObject({ agent: "claude-code", model: "opus", reviews: 1, primaries: 0, enrichments: 1, agreement: null });
    expect(row.verdicts).toEqual({ approve: 1 });
  });

  it("listAgents with opts.repo narrows to that repo and drops identities with no reviews there", async () => {
    const rows = listAgents(await seededForAgents(), { repo: "o/r1" });
    expect(rows.map((r) => r.agent)).toEqual(["claude-code", "other-bot", null]); // carol-bot (o/r2 only) is gone
    const cc = rows.find((r) => r.agent === "claude-code")!;
    expect(cc).toMatchObject({ reviews: 4, primaries: 2, enrichments: 2, repos: 1, lastActiveAt: "2026-02-02T00:00:10Z" });
  });

  it("listCollaborators aggregates pulls authored, reviews received, verdicts, and distinct agents seen across multiple pulls", async () => {
    const rows = listCollaborators(await seededForAgents());
    expect(rows.map((r) => r.login)).toEqual(["alice", "carol", "bob"]);
    const alice = rows[0];
    expect(alice).toMatchObject({ pullsAuthored: 2, reviewsReceived: 6, agentsSeen: 2, lastActivityAt: "2026-02-02T00:00:10Z" });
    expect(alice.verdicts).toEqual({ approve: 2, disagree: 1, "request-changes": 1, agree: 1 });
  });

  it("listCollaborators uses the pull's own updatedAt when it postdates all reviews on it", async () => {
    const rows = listCollaborators(await seededForAgents());
    const carol = rows.find((r) => r.login === "carol")!;
    expect(carol).toMatchObject({ pullsAuthored: 1, reviewsReceived: 2, agentsSeen: 2, lastActivityAt: "2026-02-10T00:00:00Z" });
  });

  it("listCollaborators uses a review's submittedAt when it postdates the pull's own updatedAt", async () => {
    const rows = listCollaborators(await seededForAgents());
    const bob = rows.find((r) => r.login === "bob")!;
    expect(bob).toMatchObject({ pullsAuthored: 1, reviewsReceived: 1, agentsSeen: 1, lastActivityAt: "2026-02-03T00:01:00Z" });
  });

  it("listCollaborators with opts.repo excludes collaborators with no pulls in that repo", async () => {
    const rows = listCollaborators(await seededForAgents(), { repo: "o/r1" });
    expect(rows.map((r) => r.login)).toEqual(["alice", "bob"]); // carol's only pull is in o/r2
  });

  it("listAgents and listCollaborators return empty arrays on an empty database, not errors", () => {
    const db = openDb(":memory:");
    expect(listAgents(db)).toEqual([]);
    expect(listCollaborators(db)).toEqual([]);
  });

  it("listCollaborators reports a review-less pull's own updatedAt as lastActivityAt, not null", async () => {
    // Pins the hand-rolled CASE in listCollaborators for the case no fixture above exercises: a
    // LEFT JOIN with zero matching reviews makes MAX(rv.submitted_at) NULL for the whole group, so
    // this is the one input that would surface a naive MAX(x, y)-style regression (see the comment
    // on listCollaborators).
    const gw = new FakeSyncGateway();
    gw.seedPull("o/r", { pull: pull({ author: "dave", updatedAt: "2026-01-15T00:00:00Z" }), reviews: [] });
    const db = openDb(":memory:");
    await sync(gw, db, ["o/r"]);
    const row = listCollaborators(db)[0];
    expect(row).toMatchObject({ login: "dave", pullsAuthored: 1, reviewsReceived: 0, agentsSeen: 0, lastActivityAt: "2026-01-15T00:00:00Z" });
    expect(row.verdicts).toEqual({});
  });

  it("listAgents' avgTurnaroundSeconds keeps sub-second precision instead of strftime's floor-to-whole-seconds bias", async () => {
    const gw = new FakeSyncGateway();
    gw.seedPull("o/r", {
      pull: pull(),
      reviews: [metaReview(401, {
        role: "primary", verdict: "approve", agent: "claude-code", model: "opus",
        claimedAt: "2026-01-01T00:00:00.900Z", submittedAt: "2026-01-01T00:00:01.100Z",
      })],
    });
    const db = openDb(":memory:");
    await sync(gw, db, ["o/r"]);
    // True gap is 0.2s. strftime('%s', ...) floors both sides to whole seconds first (0.900 down to
    // :00, 1.100 down to :01), which would report a full 1s here -- a systematic upward bias that
    // julianday's fractional-day arithmetic must not have.
    expect(listAgents(db)[0].avgTurnaroundSeconds).toBeCloseTo(0.2, 2);
  });

  it("listAgents clamps a negative turnaround (clock skew: submittedAt before claimedAt) to 0", async () => {
    const gw = new FakeSyncGateway();
    gw.seedPull("o/r", {
      pull: pull(),
      reviews: [metaReview(402, {
        role: "primary", verdict: "approve", agent: "claude-code", model: "opus",
        claimedAt: "2026-01-01T00:00:05Z", submittedAt: "2026-01-01T00:00:00Z", // submitted BEFORE claimed
      })],
    });
    const db = openDb(":memory:");
    await sync(gw, db, ["o/r"]);
    expect(listAgents(db)[0].avgTurnaroundSeconds).toBe(0);
  });

  it("listAgents breaks a tie on reviews and lastActiveAt deterministically by agent then model", async () => {
    const gw = new FakeSyncGateway();
    const at = "2026-01-01T00:00:00Z"; // identical for both reviews, to force a full tie
    gw.seedPull("o/r", {
      pull: pull(),
      reviews: [
        metaReview(501, { role: "primary", verdict: "approve", agent: "zeta", model: "m1", submittedAt: at }),
        metaReview(502, { role: "primary", verdict: "approve", agent: "alpha", model: "m1", submittedAt: at }),
      ],
    });
    const db = openDb(":memory:");
    await sync(gw, db, ["o/r"]);
    expect(listAgents(db).map((r) => r.agent)).toEqual(["alpha", "zeta"]);
  });

  it("listCollaborators breaks a tie on pullsAuthored and lastActivityAt deterministically by login", async () => {
    const gw = new FakeSyncGateway();
    const at = "2026-01-01T00:00:00Z"; // identical for both pulls, to force a full tie
    gw.seedPull("o/r", { pull: pull({ number: 1, author: "zoe", updatedAt: at }), reviews: [] });
    gw.seedPull("o/r", { pull: pull({ number: 2, author: "amy", updatedAt: at }), reviews: [] });
    const db = openDb(":memory:");
    await sync(gw, db, ["o/r"]);
    expect(listCollaborators(db).map((r) => r.login)).toEqual(["amy", "zoe"]);
  });

  it("listAgents keeps a verdict literally named \"__proto__\" as an own, readable key instead of silently dropping it", async () => {
    // No meta footer: this goes through map.ts's unvalidated body-scrape fallback
    // (SECOND_OPINION_PREFIX), which is exactly how an attacker-controlled verdict string reaches
    // the review table for real (see listAgents' JSDoc on why verdict is body-attested, not
    // authenticated). A plain-object `bucket[verdict] = count` would hit Object.prototype's
    // inherited __proto__ setter here and silently no-op instead of storing the count.
    const gw = new FakeSyncGateway();
    gw.seedPull("o/r", {
      pull: pull(),
      reviews: [{ id: 601, author: "some-agent", state: "COMMENTED", body: "**Second opinion (__proto__):**\n\nBody text.", commitId: "head123", submittedAt: "2026-01-02T00:00:00Z" }],
    });
    const db = openDb(":memory:");
    await sync(gw, db, ["o/r"]);
    const verdicts = listAgents(db)[0].verdicts;
    expect(Object.keys(verdicts)).toContain("__proto__");
    expect(verdicts["__proto__"]).toBe(1);
  });

  it("listCollaborators keeps a verdict literally named \"__proto__\" as an own, readable key instead of silently dropping it", async () => {
    const gw = new FakeSyncGateway();
    gw.seedPull("o/r", {
      pull: pull(), // author: alice
      reviews: [{ id: 602, author: "some-agent", state: "COMMENTED", body: "**Second opinion (__proto__):**\n\nBody text.", commitId: "head123", submittedAt: "2026-01-02T00:00:00Z" }],
    });
    const db = openDb(":memory:");
    await sync(gw, db, ["o/r"]);
    const verdicts = listCollaborators(db)[0].verdicts;
    expect(Object.keys(verdicts)).toContain("__proto__");
    expect(verdicts["__proto__"]).toBe(1);
  });

  it("listAgents keeps (agent, null) and (null, model) as identities distinct from each other and from the (null, null) unknown row", async () => {
    const gw = new FakeSyncGateway();
    gw.seedPull("o/r", {
      pull: pull(), // author: alice
      reviews: [
        metaReview(701, { role: "primary", verdict: "approve", agent: "partial-agent", submittedAt: "2026-01-02T00:00:00Z" }), // (partial-agent, null)
        metaReview(702, { role: "primary", verdict: "approve", model: "partial-model", submittedAt: "2026-01-02T00:01:00Z" }), // (null, partial-model)
        plainReview(703, { submittedAt: "2026-01-02T00:02:00Z" }), // (null, null) unknown
      ],
    });
    const db = openDb(":memory:");
    await sync(gw, db, ["o/r"]);
    const rows = listAgents(db);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.agent === "partial-agent")).toMatchObject({ agent: "partial-agent", model: null, reviews: 1 });
    expect(rows.find((r) => r.agent === null && r.model === "partial-model")).toMatchObject({ reviews: 1 });
    expect(rows.find((r) => r.agent === null && r.model === null)).toMatchObject({ reviews: 1 });

    // agentsSeen counts the two partial identities but not the (null, null) unknown one.
    expect(listCollaborators(db)[0]).toMatchObject({ login: "alice", agentsSeen: 2 });
  });
});
