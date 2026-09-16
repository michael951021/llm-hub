import Fastify, { type FastifyError } from "fastify";
import { sql } from "drizzle-orm";
import { fastifyConnectPlugin } from "@connectrpc/connect-fastify";
import { db } from "@modelhub/db";
import { redis } from "./redis.js";
import { auth } from "./auth/auth.js";
import { requireSession } from "./auth/session.js";
import { env } from "./env.js";
import { routes } from "./rpc/index.js";

// No explicit return-type annotation: with http2 enabled below, Fastify's
// factory returns FastifyInstance<Http2Server, ...>, a different (and
// incompatible) instantiation of the generic from the plain FastifyInstance
// type — inference carries the real, http2-flavored type through instead.
export async function buildApp() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    // Inventory reports (Task 10) travel over this same server; the
    // Fastify default (1MiB) is too small for those payloads.
    bodyLimit: 4 * 1024 * 1024,
    // NodeService.Connect (Task 10) is a true bidirectional stream: the
    // handler must read agent messages and yield server messages
    // concurrently over the same request. That needs HTTP/2 framing, not
    // HTTP/1.1 request/response — this is cleartext h2c (no TLS), which is
    // what @connectrpc/connect-node's Node transport speaks in-cluster.
    http2: true,
  });

  await app.register(fastifyConnectPlugin, { routes });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: "not_found", path: req.url });
  });

  app.setErrorHandler<FastifyError>((err, req, reply) => {
    req.log.error({ err }, "request failed");
    const status = err.statusCode ?? 500;
    reply.code(status).send({
      error: status >= 500 ? "internal_error" : (err.code ?? "request_error"),
      message: status >= 500 ? "internal error" : err.message,
    });
  });

  app.get("/healthz", async (_req, reply) => {
    const [database, redisStatus] = await Promise.all([
      db.execute(sql`select 1`).then(() => "ok").catch(() => "error"),
      redis.ping().then(() => "ok").catch(() => "error"),
    ]);
    const status = database === "ok" && redisStatus === "ok" ? "ok" : "degraded";
    reply.code(status === "ok" ? 200 : 503);
    return { status, database, redis: redisStatus };
  });

  // Better Auth owns every /api/auth/* route.
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    handler: async (req, reply) => {
      const url = new URL(req.url, env.PUBLIC_URL);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(", "));
      }
      const init: RequestInit = { method: req.method, headers };
      if (req.method !== "GET" && req.method !== "HEAD") {
        init.body = JSON.stringify(req.body);
      }
      const response = await auth.handler(new Request(url, init));
      reply.code(response.status);
      response.headers.forEach((value, key) => reply.header(key, value));
      return reply.send(await response.text());
    },
  });

  app.get("/api/me", async (req) => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers.set(k, v);
      else if (Array.isArray(v)) headers.set(k, v.join(", "));
    }
    const { orgId } = await requireSession(req);
    const session = await auth.api.getSession({ headers });
    const orgs = await auth.api.listOrganizations({ headers });
    const org = orgs.find((o) => o.id === orgId);
    return {
      user: { id: session!.user.id, email: session!.user.email, name: session!.user.name },
      org: { id: orgId, name: org?.name ?? "" },
    };
  });

  return app;
}
