import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { ownerDb, organization, nodes, devices } from "@modelhub/db";
import { buildApp } from "../app.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie: string;
let orgId: string;
let nodeId: string;
const GiB = 1024 ** 3;

beforeAll(async () => {
  app = await buildApp();

  const email = `fleet${Date.now()}@example.com`;
  const signUp = await app.inject({
    method: "POST", url: "/api/auth/sign-up/email",
    payload: { email, password: "correct-horse-battery", name: "Fleet Owner" },
  });
  const raw = signUp.headers["set-cookie"];
  cookie = Array.isArray(raw) ? raw.join("; ") : String(raw);

  const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
  orgId = me.json().org.id;

  // Random rather than a fixed fill pattern: nodes.publicKey is uniquely
  // indexed, and this test runs against a persistent dev database that
  // isn't truncated between runs (see node-auth.test.ts and connect.test.ts,
  // which use freshly generated keys for the same reason).
  const [node] = await ownerDb.insert(nodes).values({
    orgId, name: "4090-box", status: "online", platform: "linux", arch: "amd64",
    publicKey: randomBytes(32), lastSeenAt: new Date(),
  }).returning({ id: nodes.id });
  nodeId = node!.id;

  await ownerDb.insert(devices).values({
    orgId, nodeId: node!.id, localId: "cuda:0", kind: "cuda", index: 0,
    name: "NVIDIA GeForce RTX 4090",
    totalBytes: BigInt(24 * GiB),
    lastUsedBytes: BigInt(10 * GiB),
    lastManagedBytes: BigInt(6 * GiB),
    lastUtilization: 0.5, lastPressure: "normal", lastSampleAt: new Date(),
  });
});

afterAll(async () => { await app.close(); });

async function rpc(method: string, body: unknown, withCookie = true) {
  return app.inject({
    method: "POST",
    url: `/modelhub.v1.FleetService/${method}`,
    headers: {
      "content-type": "application/json",
      ...(withCookie ? { cookie } : {}),
    },
    payload: body as Record<string, unknown>,
  });
}

describe("FleetService", () => {
  // 401 exactly, not merely ">= 400": a 500 thrown inside requireSession
  // would satisfy a >= 400 assertion, which would let the one test whose
  // job is proving the guard works pass while the guard is broken.
  it("requires a session", async () => {
    const res = await rpc("ListNodes", {}, false);
    expect(res.statusCode).toBe(401);
  });

  it("returns nodes with budgets already computed", async () => {
    const res = await rpc("ListNodes", {});
    expect(res.statusCode).toBe(200);

    const [node] = res.json().nodes;
    expect(node.name).toBe("4090-box");
    expect(node.status).toBe("online");

    const [device] = node.devices;
    expect(device.name).toBe("NVIDIA GeForce RTX 4090");
    // 24 total − 4 foreign − 6 ours − 8% headroom
    const headroom = Math.floor(24 * GiB * 0.08);
    expect(Number(device.foreignBytes)).toBe(4 * GiB);
    expect(Number(device.headroomBytes)).toBe(headroom);
    expect(Number(device.availableBytes)).toBe(24 * GiB - 4 * GiB - 6 * GiB - headroom);
    expect(device.schedulable).toBe(true);
  });

  it("mints a pairing code for the session's org", async () => {
    const res = await rpc("CreatePairingCode", { nodeName: "mac-studio" });
    expect(res.statusCode).toBe(200);
    expect(res.json().code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(Number(res.json().expiresAtUnixMs)).toBeGreaterThan(Date.now());
  });

  it("returns a single node with its devices", async () => {
    const res = await rpc("GetNode", { nodeId });
    expect(res.statusCode).toBe(200);
    expect(res.json().node.name).toBe("4090-box");
    expect(res.json().node.devices).toHaveLength(1);
  });

  // A malformed id, an absent id, and an id in another org must be a single
  // indistinguishable outcome — otherwise GetNode is a cross-org existence
  // probe. The malformed case is also the specific regression: nodes.id is a
  // Postgres uuid column, so an unguarded eq() against a non-uuid string
  // raises SQLSTATE 22P02, which Connect maps to Internal (500).
  it("reports a malformed node id as not found, not as an internal error", async () => {
    const res = await rpc("GetNode", { nodeId: "not-a-uuid" });
    expect(res.statusCode).toBe(404);
  });

  it("reports a node in another organization as not found", async () => {
    const otherOrg = `org_${randomUUID().slice(0, 8)}`;
    await ownerDb.insert(organization).values({ id: otherOrg, name: "Other GetNode", slug: otherOrg, createdAt: new Date() });
    const [theirs] = await ownerDb.insert(nodes).values({
      orgId: otherOrg, name: "also-not-yours", publicKey: randomBytes(32),
    }).returning({ id: nodes.id });

    const res = await rpc("GetNode", { nodeId: theirs!.id });
    expect(res.statusCode).toBe(404);
  });

  it("reports an absent node id as not found", async () => {
    const res = await rpc("GetNode", { nodeId: randomUUID() });
    expect(res.statusCode).toBe(404);
  });

  it("does not leak another organization's nodes", async () => {
    const otherOrg = `org_${randomUUID().slice(0, 8)}`;
    await ownerDb.insert(organization).values({ id: otherOrg, name: "Other", slug: otherOrg, createdAt: new Date() });
    await ownerDb.insert(nodes).values({
      orgId: otherOrg, name: "not-yours", publicKey: randomBytes(32),
    });

    const res = await rpc("ListNodes", {});
    expect(res.json().nodes.map((n: { name: string }) => n.name)).not.toContain("not-yours");
  });
});
