import type { FastifyInstance } from "fastify";
import type { DB } from "./db/open.js";
import { getOverview, listRepos, listPulls, getPullDetail, listSyncRuns } from "./db/queries.js";

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
  app.get("/api/sync-runs", async () => listSyncRuns(db));
}
