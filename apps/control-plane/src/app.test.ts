import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { appSql, ownerSql } from "@modelhub/db";
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

  it("returns a structured 404 for an unknown route", async () => {
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toHaveProperty("error");
  });
});
