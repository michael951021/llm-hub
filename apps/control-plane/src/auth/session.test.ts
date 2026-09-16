import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { member, organization, ownerDb } from "@modelhub/db";
import { buildApp } from "../app.js";

let app: FastifyInstance;
const email = `t${Date.now()}@example.com`;

beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); });

async function signUp(signUpEmail: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email: signUpEmail, password: "correct-horse-battery", name: "Test User" },
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
    const cookie = await signUp(email);
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

  it("self-heals a session left with no organization", async () => {
    // Simulates the exact failure mode requireSession's self-heal exists
    // for: the sign-up hook can fail non-fatally after the user is already
    // committed (a transient DB error, a slug collision), stranding a real
    // user with a valid session and no organization. We can't easily force
    // that hook to fail from outside, so we reproduce the resulting state
    // directly -- a committed user/session with its membership and
    // organization rows gone -- and assert requireSession recovers instead
    // of permanently 403ing.
    const strandedEmail = `stranded-${Date.now()}@example.com`;
    const cookie = await signUp(strandedEmail);

    const before = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    expect(before.statusCode).toBe(200);
    const orgId = before.json().org.id as string;

    await ownerDb.delete(member).where(sql`organization_id = ${orgId}`);
    await ownerDb.delete(organization).where(sql`id = ${orgId}`);

    const after = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    expect(after.statusCode).toBe(200);
    const body = after.json();
    expect(body.user.email).toBe(strandedEmail);
    expect(body.org.id).toMatch(/^org_/);
    expect(body.org.id).not.toBe(orgId);
    expect(body.org.name).toBeTruthy();
  });
});
