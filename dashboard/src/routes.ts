import type { FastifyInstance } from "fastify";
import type { DB } from "./db/open.js";
import { getOverview, listRepos, listPulls, getPullDetail, listSyncRuns, listAgents, listCollaborators } from "./db/queries.js";

// Same owner/name shape used elsewhere in the package for a "repo" string (see core/model.ts's
// ReviewRequestSchema/ReviewResultSchema): exactly two non-empty segments separated by one slash.
const REPO_SHAPE = /^[^/]+\/[^/]+$/;

/**
 * Validates the optional `?repo=` query filter. Absent or empty means "no filter" (so a naive
 * "All repositories" UI option that submits `repo=` works, rather than 400ing). A malformed
 * non-empty value is rejected -- including a duplicated `?repo=a&repo=b` key, which Fastify's
 * querystring parser turns into a `string[]` at runtime despite the `{ repo?: string }` route
 * type: `REPO_SHAPE.test(anArray)` would coerce it via `Array#toString` (`"a,b"`) and could pass,
 * so `typeof` is checked before the regex, not just relied on for its type-narrowing side effect.
 */
function validateRepoQuery(repo: unknown): { ok: true; repo: string | undefined } | { ok: false } {
  if (!repo) return { ok: true, repo: undefined };
  if (typeof repo !== "string" || !REPO_SHAPE.test(repo)) return { ok: false };
  return { ok: true, repo };
}

/** Mount the read-only JSON API on `app`. All handlers read from `db`; none write. */
export function registerApiRoutes(app: FastifyInstance, db: DB): void {
  app.get("/api/overview", async () => getOverview(db));
  app.get("/api/repos", async () => listRepos(db));
  app.get<{ Params: { owner: string; name: string } }>("/api/repos/:owner/:name/pulls", async (req) =>
    listPulls(db, req.params.owner, req.params.name),
  );
  app.get<{ Params: { owner: string; name: string; number: string } }>(
    "/api/repos/:owner/:name/pulls/:number",
    async (req, reply) => {
      const n = Number(req.params.number);
      if (!Number.isInteger(n)) return reply.code(400).send({ error: "invalid pull number" });
      const detail = getPullDetail(db, req.params.owner, req.params.name, n);
      if (!detail) return reply.code(404).send({ error: "pull not found" });
      return detail;
    },
  );
  app.get<{ Querystring: { repo?: string } }>("/api/agents", async (req, reply) => {
    const parsed = validateRepoQuery(req.query.repo);
    if (!parsed.ok) return reply.code(400).send({ error: "invalid repo" });
    return { agents: listAgents(db, { repo: parsed.repo }) };
  });
  app.get<{ Querystring: { repo?: string } }>("/api/collaborators", async (req, reply) => {
    const parsed = validateRepoQuery(req.query.repo);
    if (!parsed.ok) return reply.code(400).send({ error: "invalid repo" });
    return { collaborators: listCollaborators(db, { repo: parsed.repo }) };
  });
  app.get("/api/sync-runs", async () => listSyncRuns(db));
}
