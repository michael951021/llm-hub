import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@modelhub/db";
import { buildApp } from "./server.js";
import { redis } from "./redis.js";

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); });

describe("browser-facing server", () => {
  it("reports healthy when its dependencies are reachable", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", database: "ok", redis: "ok" });
  });

  // An orchestrator acts on /healthz, so the failing mapping matters as much
  // as the passing one.
  it.each([
    ["database", () => vi.spyOn(db, "execute").mockRejectedValue(new Error("down"))],
    ["redis", () => vi.spyOn(redis, "ping").mockRejectedValue(new Error("down"))],
  ])("reports 503 degraded when the %s is unreachable", async (dependency, breakIt) => {
    const spy = breakIt();
    try {
      const res = await app.inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ status: "degraded", [dependency]: "error" });
    } finally {
      spy.mockRestore();
    }
  });

  it("returns a structured 404 for an unknown route", async () => {
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found", path: "/nope" });
  });
});
