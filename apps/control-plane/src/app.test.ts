import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { appSql, ownerSql, db } from "@modelhub/db";
import { buildApp } from "./app.js";
import { redis } from "./redis.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});
afterAll(async () => {
  // buildApp() only assembles Fastify; it does not own the redis client or
  // the db module's postgres.js pools (both created at import time), so
  // app.close() alone leaves open sockets that keep the process alive
  // after vitest reports a pass. Close everything this test caused to open.
  await app.close();
  await redis.quit();
  await appSql.end();
  await ownerSql.end();
});

describe("control plane", () => {
  it("reports healthy when its dependencies are reachable", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", database: "ok", redis: "ok" });
  });

  // /healthz is what an orchestrator acts on: a rollout that keeps routing
  // traffic to a control plane with no database, or that kills a healthy
  // one, both look like nothing at all until something else breaks. The
  // 200/ok path above cannot catch an inverted mapping on its own, so the
  // failing path needs its own assertion.
  it("reports 503 and degraded when the database is unreachable", async () => {
    const spy = vi.spyOn(db, "execute").mockRejectedValue(new Error("connection refused"));
    try {
      const res = await app.inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ status: "degraded", database: "error", redis: "ok" });
    } finally {
      spy.mockRestore();
    }
  });

  it("reports 503 and degraded when redis is unreachable", async () => {
    const spy = vi.spyOn(redis, "ping").mockRejectedValue(new Error("connection refused"));
    try {
      const res = await app.inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ status: "degraded", database: "ok", redis: "error" });
    } finally {
      spy.mockRestore();
    }
  });

  it("returns a structured 404 for an unknown route", async () => {
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toHaveProperty("error");
  });
});
