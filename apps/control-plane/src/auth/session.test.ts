import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";

let app: FastifyInstance;
const email = `t${Date.now()}@example.com`;

beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); });

async function signUp() {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email, password: "correct-horse-battery", name: "Test User" },
  });
  expect(res.statusCode).toBeLessThan(400);
  const cookie = res.headers["set-cookie"];
  return Array.isArray(cookie) ? cookie.join("; ") : String(cookie);
}

describe("sessions and organizations", () => {
  it("rejects an unauthenticated request to a guarded route", async () => {
    const res = await app.inject({ method: "GET", url: "/api/me" });
    expect(res.statusCode).toBe(401);
  });

  it("creates a personal organization on sign-up", async () => {
    const cookie = await signUp();
    const res = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.email).toBe(email);
    expect(body.org.id).toMatch(/^org_/);
    expect(body.org.name).toBeTruthy();
  });

  it("rejects a forged session cookie", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: "better-auth.session_token=not-a-real-token" },
    });
    expect(res.statusCode).toBe(401);
  });
});
