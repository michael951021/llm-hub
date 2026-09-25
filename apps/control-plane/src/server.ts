import Fastify, { type FastifyError, type FastifyInstance, type RawServerBase } from "fastify";
import type { ConnectRouter } from "@connectrpc/connect";
import { fastifyConnectPlugin } from "@connectrpc/connect-fastify";
import { fromNodeHeaders } from "better-auth/node";
import { sql } from "drizzle-orm";
import { db } from "@modelhub/db";
import { auth } from "./auth/auth.js";
import { requireSession } from "./auth/session.js";
import { env } from "./env.js";
import { redis } from "./redis.js";
import { registerFleetService } from "./rpc/fleet-service.js";
import { registerNodeService } from "./rpc/node-service.js";

// The control plane runs two listeners. Agents need a bidirectional stream
// (NodeService.Connect), which needs HTTP/2; browsers cannot speak
// cleartext HTTP/2 at all. So in dev, browsers get HTTP/1.1 on PORT and
// agents get h2c on AGENT_PORT. See docs/deployment.md for production.

const baseOptions = {
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  // Inventory reports can exceed Fastify's 1 MiB default.
  bodyLimit: 4 * 1024 * 1024,
};

type AnyFastify = FastifyInstance<RawServerBase, any, any, any>;

/** Mounts Connect routes plus JSON 404 and error handlers shared by both listeners. */
async function withConnect<T extends AnyFastify>(
  app: T, routes: (router: ConnectRouter) => void,
): Promise<T> {
  await app.register(fastifyConnectPlugin, { routes });
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: "not_found", path: req.url });
  });
  app.setErrorHandler<FastifyError>((err, req, reply) => {
    req.log.error({ err }, "request failed");
    const status = err.statusCode ?? 500;
    reply.code(status).send(status >= 500
      ? { error: "internal_error", message: "internal error" }
      : { error: err.code ?? "request_error", message: err.message });
  });
  return app;
}

/** Browser-facing: /healthz, Better Auth, /api/me, and FleetService over HTTP/1.1. */
export async function buildApp() {
  const app = await withConnect(Fastify(baseOptions), registerFleetService);

  app.get("/healthz", async (_req, reply) => {
    const [database, cache] = await Promise.all([
      db.execute(sql`select 1`).then(() => "ok", () => "error"),
      redis.ping().then(() => "ok", () => "error"),
    ]);
    const status = database === "ok" && cache === "ok" ? "ok" : "degraded";
    reply.code(status === "ok" ? 200 : 503);
    return { status, database, redis: cache };
  });

  // Better Auth owns every /api/auth/* route; Fastify has already parsed the body.
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    handler: async (req, reply) => {
      const response = await auth.handler(new Request(new URL(req.url, env.PUBLIC_URL), {
        method: req.method,
        headers: fromNodeHeaders(req.headers),
        ...(req.method === "POST" ? { body: JSON.stringify(req.body) } : {}),
      }));
      reply.code(response.status);
      response.headers.forEach((value, key) => reply.header(key, value));
      return reply.send(await response.text());
    },
  });

  app.get("/api/me", async (req) => {
    const headers = fromNodeHeaders(req.headers);
    const { user, orgId } = await requireSession(headers);
    const orgs = await auth.api.listOrganizations({ headers });
    return {
      user: { id: user.id, email: user.email, name: user.name },
      org: { id: orgId, name: orgs.find((o) => o.id === orgId)?.name ?? "" },
    };
  });

  return app;
}

/** Agent-facing: NodeService (Enroll, Connect) over cleartext HTTP/2. */
export async function buildAgentApp() {
  return withConnect(Fastify({ ...baseOptions, http2: true }), registerNodeService);
}
