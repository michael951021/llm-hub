import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { db } from "@modelhub/db";
import { redis } from "./redis.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

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

  return app;
}
