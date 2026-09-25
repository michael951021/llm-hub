import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { organization, ownerDb } from "@modelhub/db";
import { buildApp } from "../server.js";
import { signUp } from "../test-helpers.js";

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); });

const me = (cookie?: string) =>
  app.inject({ method: "GET", url: "/api/me", headers: cookie ? { cookie } : {} });

describe("sessions and organizations", () => {
  it("rejects a request with no session", async () => {
    expect((await me()).statusCode).toBe(401);
  });

  it("rejects a forged session cookie", async () => {
    expect((await me("better-auth.session_token=not-a-real-token")).statusCode).toBe(401);
  });

  it("creates a personal organization on sign-up", async () => {
    const { cookie, email } = await signUp(app);
    const res = await me(cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe(email);
    expect(res.json().org.id).toMatch(/^org_/);
    expect(res.json().org.name).toBeTruthy();
  });

  it("self-heals a user left with no organization", async () => {
    // The state a failed (non-fatal) sign-up hook leaves behind.
    const { cookie, orgId } = await signUp(app);
    await ownerDb.delete(organization).where(eq(organization.id, orgId));

    const res = await me(cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().org.id).toMatch(/^org_/);
    expect(res.json().org.id).not.toBe(orgId);
  });
});
