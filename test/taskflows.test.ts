import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

// Structural tests for the three expedition taskflows. They are hand-authored JSON that a
// pi-taskflow host validates only at run time, on someone else's machine, so the invariants that
// would otherwise fail there are asserted here instead: the flow files parse, the safety-relevant
// fields hold the values the design mandates, every path a phase points at exists, and the shipped
// templates under `pi/taskflows/` stay byte-identical to the copies this repository dogfoods under
// `.pi/taskflows/`.
//
// The pi-taskflow rules encoded below come from its own schema (`taskflow-core/src/schema.ts`):
// script phases reject `output: "json"`, warn (and therefore, under `strictInterpolation`, fail) on
// `idleTimeout`, and cap `timeout` at 300000 ms; phase ids must use hyphens, not underscores; and a
// `{steps.X.*}` reference must be reachable through `dependsOn`.

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const TEMPLATE_DIR = path.join(REPO_ROOT, "pi", "taskflows");
const DOGFOOD_DIR = path.join(REPO_ROOT, ".pi", "taskflows");
const FLOW_NAMES = ["pr-requester", "pr-reviewer", "pr-steward"] as const;
const SCRIPT_TIMEOUT_MAX_MS = 300_000;

interface Phase {
  id: string;
  type?: string;
  run?: string[];
  context?: string[];
  task?: string;
  over?: string;
  input?: string;
  dependsOn?: string[];
  timeout?: number;
  idleTimeout?: number;
  output?: string;
  agent?: string;
  final?: boolean;
  idempotent?: boolean;
  optional?: boolean;
}

interface Flow {
  name: string;
  description: string;
  concurrency: number;
  strictInterpolation: boolean;
  args: Record<string, { type?: string; values?: string[]; default?: unknown }>;
  phases: Phase[];
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

/** Every `.json` file in a taskflow directory, sidecars included, as repo-relative paths. */
function flowJsonFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => path.join(dir, name));
}

const bothDirs: Array<{ label: string; dir: string }> = [
  { label: "pi/taskflows", dir: TEMPLATE_DIR },
  { label: ".pi/taskflows", dir: DOGFOOD_DIR },
];

describe("taskflow files", () => {
  for (const { label, dir } of bothDirs) {
    it(`${label}: every JSON file parses`, () => {
      const files = flowJsonFiles(dir);
      expect(files.length).toBe(FLOW_NAMES.length * 2); // one flow + one sidecar each
      for (const file of files) {
        expect(() => readJson(file), file).not.toThrow();
      }
    });

    it(`${label}: holds exactly the three expected flows`, () => {
      const names = FLOW_NAMES.map((name) => (readJson(path.join(dir, `${name}.json`)) as Flow).name);
      expect(names).toEqual([...FLOW_NAMES]);
    });

    for (const name of FLOW_NAMES) {
      describe(`${label}: ${name}`, () => {
        const flow = readJson(path.join(dir, `${name}.json`)) as Flow;

        it("is propose-only by default, with no autonomy in any config file", () => {
          // The propose default lives in the flow's args and nowhere else: `auto` therefore takes an
          // explicit per-invocation opt-in (`/tf:<name> autonomy=auto`) that shows up in the run log.
          expect(flow.args.autonomy).toBeDefined();
          expect(flow.args.autonomy.default).toBe("propose");
          expect(flow.args.autonomy.values).toEqual(["propose", "auto"]);

          for (const configName of ["config.json", "config.example.json"]) {
            const configPath = path.join(dir, name, configName);
            if (!existsSync(configPath)) continue;
            const config = readJson(configPath) as Record<string, unknown>;
            expect(Object.keys(config), configPath).not.toContain("autonomy");
          }
        });

        it("bounds parallelism at 4 and fails closed on unresolved placeholders", () => {
          expect(flow.concurrency).toBe(4);
          expect(flow.strictInterpolation).toBe(true);
        });

        it("runs discover, then a map over the executor, then summarize", () => {
          expect(flow.phases.map((phase) => phase.type)).toEqual(["script", "map", "script"]);
          const [discover, process_, summarize] = flow.phases;
          expect(discover.id).toBe("discover");
          expect(process_.id).toBe("process");
          expect(summarize.id).toBe("summarize");
          expect(process_.agent).toBe("executor");
          // The map posts comments and submits reviews, so it must never be auto-retried or cached,
          // and a single failed pull request must not cost the run its summary.
          expect(process_.idempotent).toBe(false);
          expect(process_.optional).toBe(true);
          expect(summarize.final).toBe(true);
        });

        it("passes the autonomy argument into the map task", () => {
          expect(flow.phases[1].task).toContain("{args.autonomy}");
        });

        // Both copies carry the SAME repository-relative `.pi/taskflows/...` paths, because the
        // shipped templates are written to be copied into a consumer's `.pi/taskflows/` and to
        // resolve there without editing. So the two copies get different assertions, each stating
        // what is actually true of it:
        //
        //   dogfood  - the paths resolve against this repository root, so the files must exist here.
        //   template - the files those paths name do NOT exist at that location in this package
        //              (they live under `pi/taskflows/`), so only the consumer-side prefix is
        //              asserted, plus the existence of the corresponding file in the template tree.
        const assetPaths = (phase: Phase): string[] =>
          [...(phase.run ?? []).filter((entry) => entry.endsWith(".mjs")), ...(phase.context ?? [])];

        if (dir === DOGFOOD_DIR) {
          it("points every run and context path at a file that exists in this repository", () => {
            for (const phase of flow.phases) {
              for (const entry of assetPaths(phase)) {
                expect(existsSync(path.join(REPO_ROOT, entry)), `${phase.id}: ${entry}`).toBe(true);
              }
            }
          });
        } else {
          it("points every run and context path at the consumer-side .pi/taskflows layout", () => {
            for (const phase of flow.phases) {
              for (const entry of assetPaths(phase)) {
                expect(entry.startsWith(`.pi/taskflows/${name}/`), `${phase.id}: ${entry}`).toBe(true);
                // The asset itself ships from this package's own tree, under the same basename.
                const shipped = path.join(TEMPLATE_DIR, name, path.basename(entry));
                expect(existsSync(shipped), `${phase.id}: ${shipped}`).toBe(true);
              }
            }
          });
        }

        it("obeys the pi-taskflow rules for script phases", () => {
          for (const phase of flow.phases.filter((p) => p.type === "script")) {
            expect(phase.output, phase.id).toBeUndefined();
            expect(phase.idleTimeout, phase.id).toBeUndefined();
            expect(phase.timeout, phase.id).toBeGreaterThanOrEqual(1000);
            expect(phase.timeout, phase.id).toBeLessThanOrEqual(SCRIPT_TIMEOUT_MAX_MS);
          }
        });

        it("uses hyphenated phase ids and reachable step references", () => {
          const ids = new Set(flow.phases.map((phase) => phase.id));
          for (const phase of flow.phases) {
            expect(phase.id).not.toContain("_");
            const text = [phase.task, phase.over, phase.input, ...(phase.run ?? []), ...(phase.context ?? [])]
              .filter((value): value is string => typeof value === "string")
              .join("\n");
            for (const ref of stepRefs(text)) {
              expect(ids.has(ref), `${phase.id} references unknown phase '${ref}'`).toBe(true);
              expect(phase.dependsOn ?? [], `${phase.id} references '${ref}' without depending on it`).toContain(ref);
            }
          }
        });

        it("has a sidecar describing the same flow", () => {
          const meta = readJson(path.join(dir, `${name}.meta.json`)) as Record<string, unknown>;
          expect(meta.schemaVersion).toBe(1);
          expect(meta.phaseCount).toBe(flow.phases.length);
          expect(meta.phaseSignature).toBe("script→map→script");
          expect(meta.agentUsage).toEqual(["executor"]);
          // Embedding fields are derived by the host, never hand-authored.
          for (const key of ["embedding", "embeddingModel", "embeddingDim", "embeddedAt"]) {
            expect(Object.keys(meta)).not.toContain(key);
          }
        });
      });
    }
  }

  it("keeps the dogfood copies identical to the shipped templates", () => {
    // The only intended difference is the real `config.json` per flow, which the templates ship as
    // `config.example.json` instead. Anything else drifting means one copy was edited alone.
    for (const name of FLOW_NAMES) {
      for (const file of [`${name}.json`, `${name}.meta.json`]) {
        expect(readFileSync(path.join(DOGFOOD_DIR, file), "utf8"), file)
          .toBe(readFileSync(path.join(TEMPLATE_DIR, file), "utf8"));
      }
      for (const asset of ["discover.mjs", "summarize.mjs", "instructions.md", "config.example.json"]) {
        const relative = path.join(name, asset);
        expect(readFileSync(path.join(DOGFOOD_DIR, relative), "utf8"), relative)
          .toBe(readFileSync(path.join(TEMPLATE_DIR, relative), "utf8"));
      }
    }
  });

  it("names this repository in every dogfood config", () => {
    for (const name of FLOW_NAMES) {
      const config = readJson(path.join(DOGFOOD_DIR, name, "config.json")) as { repos?: unknown };
      expect(config.repos, name).toEqual(["input-output-hk/agent-peer-review"]);
    }
  });

  it("writes American English with no em dashes", () => {
    // Escaped rather than written literally so this file does not itself contain the character.
    const EM_DASH = "\u2014";
    for (const { dir } of bothDirs) {
      for (const file of allFiles(dir)) {
        expect(readFileSync(file, "utf8").includes(EM_DASH), file).toBe(false);
      }
    }
  });
});

// The summary script is the one flow asset with behavior of its own: it is executed by the runtime
// with the map phase's combined output on stdin, and its counts are all a maintainer reads after a
// run. It is run here exactly as the runtime runs it (a real `node` process, real stdin), against
// fixtures shaped like the runtime's output. Only the shipped copy is executed: the test above proves
// the dogfood copy is byte-identical.
describe("taskflow summarize.mjs", () => {
  const summarize = (flow: string, input: string): string =>
    execFileSync(process.execPath, [path.join(TEMPLATE_DIR, flow, "summarize.mjs")], { input, encoding: "utf8" });

  /** A map-phase item: the runtime's header, then whatever the agent printed under it. */
  const item = (index: number, total: number, lines: string[], failed = false): string =>
    [`### [${index}/${total}] executor${failed ? " (failed)" : ""}`, ...lines].join("\n");

  it("pr-requester counts each action, and a blocked item is not treated as stopped", () => {
    const out = summarize("pr-requester", [
      item(1, 7, ['{"repo": "o/r", "number": 1, "stabilize": "updated", "expedite": "proposed", "requested": "skipped"}']),
      item(2, 7, ["this line is not JSON at all", '{"repo": "o/r", "number": 2, "stabilize": "up-to-date", "expedite": "merged", "requested": "skipped"}']),
      item(3, 7, ['{"repo": "o/r", "number": 3, "stabilize": "conflict", "expedite": "escalate-human", "requested": "skipped"}']),
      item(4, 7, ['{"repo": "o/r", "number": 4, "stabilize": "blocked", "expedite": "proposed", "requested": "requested"}']),
      item(5, 7, ['{"repo": "o/r", "number": 5, "stabilize": "gone", "expedite": "skipped", "requested": "skipped"}']),
      item(6, 7, ['{"repo": "o/r", "number": 6, "stabilize": "up-to-date", "expedite": "blocked", "requested": "skipped"}']),
      item(7, 7, [], true),
    ].join("\n"));

    const lines = out.trimEnd().split("\n");
    expect(lines[0]).toBe("pr-requester: 7 pull request(s). stabilized=1 proposed=2 merged=1 review-requested=1 escalated=1 failed=1");
    expect(lines.slice(1)).toEqual([
      "- o/r #3: needs a human (stabilize reported conflict)",
      "- o/r #5: stopped at stabilize; the pull request is closed or merged",
      "- o/r #6: the merge was refused",
      "- item 7 of 7: the agent did not report a result", // a failed item is named by its position
    ]);
    // Items 5 and 6 contribute to no counter at all, only to the attention list: a pull request the
    // flow walked away from, or one whose merge GitHub refused, is never invisible, and neither is
    // silently filed as a failure.
    // The blocked-at-stabilize item (4) is the mirror image: counted as proposed, with no attention
    // line, because "blocked" does not stop an item and a summary that flagged it would train a
    // reader to expect the opposite.
    expect(out).not.toContain("#4");
  });

  it("pr-reviewer counts all six watch outcomes plus the two review actions", () => {
    const out = summarize("pr-reviewer", [
      item(1, 8, ['{"repo": "o/r", "number": 1, "kind": "requested", "action": "reviewed", "verdict": "request-changes"}']),
      item(2, 8, ['{"repo": "o/r", "number": 2, "kind": "watching", "action": "re-reviewed", "verdict": "approve"}']),
      item(3, 8, ['{"repo": "o/r", "number": 3, "kind": "watching", "action": "wait", "verdict": "none"}']),
      item(4, 8, ['{"repo": "o/r", "number": 4, "kind": "watching", "action": "hold-for-human", "verdict": "none"}']),
      item(5, 8, ['{"repo": "o/r", "number": 5, "kind": "watching", "action": "abandoned", "verdict": "none"}']),
      item(6, 8, ["{not json}", '{"repo": "o/r", "number": 6, "kind": "watching", "action": "approved", "verdict": "none"}']),
      item(7, 8, ['{"repo": "o/r", "number": 7, "kind": "watching", "action": "none", "verdict": "none"}']),
      item(8, 8, [], true),
    ].join("\n"));

    const lines = out.trimEnd().split("\n");
    expect(lines[0]).toBe(
      "pr-reviewer: 8 pull request(s). reviewed=1 re-reviewed=1 waiting=1 held-for-human=1 abandoned=1 approved=1 no-verdict=1 failed=1",
    );
    expect(lines.slice(1)).toEqual([
      "- o/r #1: changes requested",
      "- o/r #4: handed to a human",
      "- item 8 of 8: the agent did not report a result",
    ]);
  });

  it("pr-steward counts each verdict and quotes the reason behind a refused merge", () => {
    const out = summarize("pr-steward", [
      item(1, 7, ['{"repo": "o/r", "number": 1, "action": "proposed", "reasons": ["autonomy is propose, not auto"]}']),
      item(2, 7, ['{"repo": "o/r", "number": 2, "action": "already-proposed", "reasons": []}']),
      item(3, 7, ['{"repo": "o/r", "number": 3, "action": "approved-and-merged", "reasons": []}']),
      item(4, 7, ['{"repo": "o/r", "number": 4, "action": "not-eligible", "reasons": ["semver level is major"]}']),
      item(5, 7, ["oops, not JSON", '{"repo": "o/r", "number": 5, "action": "blocked", "reasons": ["merge refused: the \\"head\\" moved"]}']),
      item(6, 7, [], true),
      // The approval landed and the merge did not: counted apart from approved-and-merged, because
      // reporting it as a merge would say the upgrade shipped when it is only unblocked.
      item(7, 7, ['{"repo": "o/r", "number": 7, "action": "approved", "reasons": ["branch protection still not satisfied after approving"]}']),
    ].join("\n"));

    const lines = out.trimEnd().split("\n");
    expect(lines[0]).toBe("pr-steward: 7 pull request(s). proposed=2 approved=1 approved-and-merged=1 not-eligible=1 blocked=1 failed=1");
    expect(lines.slice(1)).toEqual([
      // A not-eligible upgrade (item 4) is a hand-off, and it writes nothing at all on the pull
      // request, so the summary is the only place it can be seen. Silence there left the flow's
      // refusals invisible and permanent on exactly the pull requests it exists for (issue #50).
      "- o/r #4: not eligible for the automated path, so a human decides it (semver level is major)",
      '- o/r #5: the merge was refused (merge refused: the "head" moved)', // JSON escapes survive
      "- item 6 of 7: the agent did not report a result",
      "- o/r #7: approved, not merged (branch protection still not satisfied after approving)",
    ]);
  });

  it.each([
    ["pr-requester", "pr-requester: no candidate pull requests."],
    ["pr-reviewer", "pr-reviewer: no review requests and nothing to follow up on."],
    ["pr-steward", "pr-steward: no open bot dependency upgrades."],
  ])("%s says so plainly when the map phase produced nothing", (flow, expected) => {
    expect(summarize(flow, "").trimEnd()).toBe(expected);
  });
});

// Drift guards between the instructions the executor is handed and the code it drives. Both halves
// are prose to a taskflow host: nothing validates them until a model reads them mid-run and calls a
// tool that does not exist, or branches on a status an operation cannot return. A rename in either
// place has to break the build here instead.
describe("taskflow instructions and the code they drive", () => {
  const EXTENSION = readFileSync(path.join(REPO_ROOT, "pi", "src", "extension.ts"), "utf8");
  const REGISTERED_TOOLS = registeredToolNames(EXTENSION);

  it("finds the registered tool names in the extension at all", () => {
    // A guard on the scan itself: if registerTool's shape ever changes, the assertions below would
    // pass vacuously against an empty list.
    expect(REGISTERED_TOOLS.length).toBeGreaterThanOrEqual(11);
    expect(REGISTERED_TOOLS).toContain("pr_expedite");
  });

  for (const { label, dir } of bothDirs) {
    for (const name of FLOW_NAMES) {
      it(`${label}: ${name} names only tools the extension registers`, () => {
        const spans = codeSpans(readFileSync(path.join(dir, name, "instructions.md"), "utf8"));
        const mentioned = [...spans].filter(isToolToken).sort();
        expect(mentioned.length).toBeGreaterThan(0); // every flow drives at least one tool
        for (const tool of mentioned) {
          expect(REGISTERED_TOOLS, `${name} instructions name "${tool}"`).toContain(tool);
        }
      });
    }
  }

  // The token pins below cannot see MEANING, and the regression they exist for was a meaning: an
  // instruction that named `blocked` correctly and told the executor to stop on it. The sentences
  // that carry the fix are therefore pinned literally. They are load-bearing prose, not phrasing:
  // deleting either one restores the deadlock while every token assertion still passes.
  for (const { label, dir } of bothDirs) {
    it(`${label}: pr-requester keeps telling the executor to continue through blocked`, () => {
      const instructions = readFileSync(path.join(dir, "pr-requester", "instructions.md"), "utf8");
      expect(instructions).toContain("`up-to-date`, `updated`, or `blocked`: continue");
      expect(instructions).toContain("`blocked` does **not** mean the pull request is finished.");
      expect(instructions).toContain("Never stop the item here.");
    });
  }

  // The outcome words each flow branches on, and where each one is defined. The table is the
  // contract, asserted in both directions below: the operation's own union must hold exactly these
  // members, and the instructions must name every one of them. So renaming a status, splitting one
  // in two, or adding a new one fails here rather than in a live run, which is how the Task 2 fix
  // (stabilize's "gone" / "blocked" split) has to stay pinned.
  const OUTCOME_CONTRACTS: Array<{ what: string; file: string; field: string; end: string; flow: string; outcomes: string[] }> = [
    {
      what: "stabilize status", file: "core/operations/stabilize.ts", field: "status:", end: ";", flow: "pr-requester",
      outcomes: ["up-to-date", "updated", "conflict", "blocked", "draft", "gone"],
    },
    {
      what: "expedite action", file: "core/operations/expedite.ts", field: "action:", end: ";", flow: "pr-requester",
      outcomes: ["merged", "proposed", "already-proposed", "not-eligible", "blocked"],
    },
    {
      what: "requestPeerReview status", file: "core/operations/request-peer-review.ts", field: "status:", end: ";", flow: "pr-requester",
      outcomes: ["requested", "already-requested", "bot-authored"],
    },
    {
      what: "watchAndReReview action", file: "core/operations/watch-and-re-review.ts", field: "action:", end: ";", flow: "pr-reviewer",
      outcomes: ["re-review", "wait", "hold-for-human", "abandoned", "approved", "none"],
    },
    {
      what: "enrichReview status", file: "core/operations/enrich.ts", field: "status:", end: ";", flow: "pr-reviewer",
      outcomes: ["enriched", "waiting", "promote"],
    },
    {
      what: "claim role", file: "core/model.ts", field: "export type Role =", end: ";", flow: "pr-reviewer",
      outcomes: ["anchor", "enricher"],
    },
    {
      what: "completeReview event", file: "core/model.ts", field: "event: z.enum([", end: "]", flow: "pr-reviewer",
      outcomes: ["approve", "request-changes", "comment"],
    },
    {
      what: "enrichReview verdict", file: "core/model.ts", field: "overallVerdict: z.enum([", end: "]", flow: "pr-reviewer",
      outcomes: ["agree", "disagree", "mixed"],
    },
    {
      what: "approveDependencyUpgrade action", file: "core/operations/approve-dependency-upgrade.ts", field: "action:", end: ";", flow: "pr-steward",
      outcomes: ["approved-and-merged", "approved", "proposed", "already-proposed", "not-eligible", "blocked"],
    },
  ];

  for (const contract of OUTCOME_CONTRACTS) {
    it(`${contract.what} is exactly what ${contract.flow} branches on`, () => {
      const source = readFileSync(path.join(REPO_ROOT, contract.file), "utf8");
      const declared = literalsAfter(source, contract.field, contract.end);
      // Set equality, not containment: an operation that GAINS an outcome no instruction handles is
      // as much a drift as one that renames an outcome the instructions still expect.
      expect([...declared].sort(), contract.file).toEqual([...contract.outcomes].sort());

      for (const { label, dir } of bothDirs) {
        const spans = codeSpans(readFileSync(path.join(dir, contract.flow, "instructions.md"), "utf8"));
        for (const outcome of contract.outcomes) {
          expect(spans.has(outcome), `${label}/${contract.flow} does not name \`${outcome}\``).toBe(true);
        }
      }
    });
  }
});

/** Phase ids referenced as `{steps.<id>.…}`, found by a linear scan of the template text. */
function stepRefs(text: string): string[] {
  const marker = "{steps.";
  const refs = new Set<string>();
  let from = 0;
  for (;;) {
    const start = text.indexOf(marker, from);
    if (start === -1) break;
    const rest = text.slice(start + marker.length);
    const end = Math.min(...[".", "}"].map((ch) => (rest.indexOf(ch) === -1 ? rest.length : rest.indexOf(ch))));
    if (end > 0) refs.add(rest.slice(0, end));
    from = start + marker.length;
  }
  return Array.from(refs);
}

/**
 * Tool names registered in the pi extension, found by a linear scan for `name: "..."`.
 *
 * A scan, not a regex or a real parse: every registration is hand-written in one shape, and the only
 * thing this needs to be is obviously correct. Extra matches would be harmless (the assertions ask
 * whether a name IS registered), so the risk is a missed one, which the sanity check above catches.
 */
function registeredToolNames(source: string): string[] {
  const marker = 'name: "';
  const names: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf(marker, from);
    if (start === -1) break;
    const valueStart = start + marker.length;
    const end = source.indexOf('"', valueStart);
    if (end === -1) break;
    names.push(source.slice(valueStart, end));
    from = end + 1;
  }
  return names;
}

/** True for a bare tool identifier, e.g. `pr_expedite`, and false for prose that merely starts with one. */
function isToolToken(span: string): boolean {
  if (!["pr_", "review_", "labels_"].some((prefix) => span.startsWith(prefix))) return false;
  for (const ch of span) {
    const ok = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "_";
    if (!ok) return false;
  }
  return true;
}

/**
 * Every backtick-delimited span in a markdown file.
 *
 * Split on the delimiter and keep every piece, rather than trusting index parity: a fenced code block
 * carries three backticks at a time and flips the parity of everything after it. The pieces from
 * outside a span are prose runs that still carry their surrounding whitespace and punctuation, so they
 * cannot be mistaken for one of the bare identifiers or outcome words looked up here.
 */
function codeSpans(markdown: string): Set<string> {
  return new Set(markdown.split("`"));
}

/**
 * The string literals of a union or enum declared right after `field`, up to the first `end`.
 *
 * Reads the declaration out of the TypeScript source itself (`status: "a" | "b";`, or
 * `event: z.enum(["a", "b"])`) so the outcome contract is checked against the code rather than
 * against a second copy of it. Throws rather than returning nothing when the field cannot be found,
 * because a silent empty result would make every assertion built on it pass for the wrong reason.
 */
function literalsAfter(source: string, field: string, end: string): string[] {
  const start = source.indexOf(field);
  if (start === -1) throw new Error(`could not find "${field}" in the source`);
  const stop = source.indexOf(end, start + field.length);
  if (stop === -1) throw new Error(`could not find "${end}" after "${field}"`);
  const declaration = source.slice(start + field.length, stop);
  const literals: string[] = [];
  let from = 0;
  for (;;) {
    const open = declaration.indexOf('"', from);
    if (open === -1) break;
    const close = declaration.indexOf('"', open + 1);
    if (close === -1) break;
    literals.push(declaration.slice(open + 1, close));
    from = close + 1;
  }
  if (literals.length === 0) throw new Error(`no string literals follow "${field}"`);
  return literals;
}

/** Every file under a directory, recursively, sorted for a stable failure message. */
function allFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...allFiles(full));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}
