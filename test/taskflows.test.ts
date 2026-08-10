import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
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
