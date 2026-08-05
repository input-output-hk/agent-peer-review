import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { DB } from "./db/open.js";
import { registerApiRoutes } from "./routes.js";

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function defaultStaticRoot(): string {
  // server.js runs from dist/, so public/ is one level up from dist.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
}

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

/**
 * Build the read-only dashboard server: the DNS-rebinding guard, a global rate limit, the JSON
 * API routes, and static SPA serving with an API-aware not-found fallback (unknown `/api/*` paths
 * get JSON 404; every other unmatched path gets the SPA shell so client-side routing works on
 * refresh/deep link).
 */
export function buildServer(opts: {
  db: DB;
  staticRoot?: string;
  rateLimit?: { max: number; timeWindow: string | number };
}): FastifyInstance {
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

  // Global rate limit (defense-in-depth against a hammering client pegging the read-only DB).
  // This is a localhost single-user tool, so the default ceiling is generous.
  app.register(rateLimit, opts.rateLimit ?? { max: 600, timeWindow: "1 minute" });

  // `.register()` only queues the plugin; Fastify (via avvio) runs its body -- including the
  // `onRoute` hook it uses to attach rate limiting -- later, during the boot sequence triggered by
  // `.ready()`/`.listen()`/`.inject()`. Declaring routes synchronously right here would run before
  // that body executes, so the rate limiter would never see them. `.after()` defers route
  // declaration to its correct place in that same boot sequence, once the plugin above has fully
  // registered, so every route below is covered.
  app.after((err) => {
    if (err) throw err;

    registerApiRoutes(app, opts.db);

    // Register static AFTER the API routes: the not-found handler below is what actually decides
    // between a JSON 404 (for /api/* misses) and the SPA shell (for everything else), and it only
    // sees requests that neither the API routes nor `wildcard: false`'s explicit file/index routes
    // matched.
    const root = opts.staticRoot ?? defaultStaticRoot();
    app.register(fastifyStatic, { root, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) {
        reply.code(404).send({ error: "not found" });
        return;
      }
      reply.sendFile("index.html"); // SPA history fallback
    });
  });

  return app;
}
