import Fastify, { type FastifyInstance } from "fastify";
import type { DB } from "./db/open.js";

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const m = hostHeader.match(/^(\[[^\]]+\]|[^:]+)(?::\d+)?$/);
  if (!m) return null;
  return m[1].replace(/^\[/, "").replace(/\]$/, "");
}

export function isAllowedHost(hostHeader: string | undefined): boolean {
  const h = hostnameOf(hostHeader);
  return h !== null && ALLOWED_HOSTS.has(h);
}

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true; // same-origin requests omit Origin
  let host: string;
  try { host = new URL(origin).hostname; } catch { return false; } // malformed -> reject
  return ALLOWED_HOSTS.has(host.replace(/^\[/, "").replace(/\]$/, ""));
}

/** Build the read-only dashboard server. Registers the DNS-rebinding guard; routes and static are added by later steps. */
export function buildServer(opts: { db: DB; staticRoot?: string }): FastifyInstance {
  const app = Fastify({ logger: false });

  // DNS-rebinding guard: only requests whose Host (and Origin, if present) are localhost are served.
  app.addHook("onRequest", async (req, reply) => {
    if (!isAllowedHost(req.headers.host)) {
      await reply.code(403).send({ error: "forbidden host" });
      return reply;
    }
    if (!isAllowedOrigin(req.headers.origin)) {
      await reply.code(403).send({ error: "forbidden origin" });
      return reply;
    }
  });

  // registerApiRoutes(app, opts.db);      // Task 3
  // registerStatic(app, opts.staticRoot); // Task 4
  return app;
}
