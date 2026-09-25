import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { devices, ownerDb } from "@modelhub/db";
import { buildApp } from "../server.js";
import { createNode, createOrg, GiB, signUp } from "../test-helpers.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie: string;
let nodeId: string;
let otherOrgNodeId: string;

beforeAll(async () => {
  app = await buildApp();
  const user = await signUp(app);
  cookie = user.cookie;

  ({ nodeId } = await createNode(user.orgId, {
    name: "4090-box", status: "online", platform: "linux", arch: "amd64", lastSeenAt: new Date(),
  }));
  await ownerDb.insert(devices).values({
    orgId: user.orgId, nodeId, localId: "cuda:0", kind: "cuda", name: "NVIDIA GeForce RTX 4090",
    totalBytes: BigInt(24 * GiB), lastUsedBytes: BigInt(10 * GiB), lastManagedBytes: BigInt(6 * GiB),
    lastUtilization: 0.5, lastSampleAt: new Date(),
  });

  ({ nodeId: otherOrgNodeId } = await createNode(await createOrg("Other"), { name: "not-yours" }));
});

afterAll(async () => { await app.close(); });

function rpc(method: string, body: object, auth = true) {
  return app.inject({
    method: "POST",
    url: `/modelhub.v1.FleetService/${method}`,
    headers: { "content-type": "application/json", ...(auth ? { cookie } : {}) },
    payload: body,
  });
}

describe("FleetService", () => {
  // Exactly 401: a 500 inside requireSession would also satisfy ">= 400".
  it("requires a session", async () => {
    expect((await rpc("ListNodes", {}, false)).statusCode).toBe(401);
  });

  it("lists only this org's nodes, with budgets already computed", async () => {
    const res = await rpc("ListNodes", {});
    expect(res.statusCode).toBe(200);
    const { nodes } = res.json();
    expect(nodes.map((n: { name: string }) => n.name)).toEqual(["4090-box"]);

    const [device] = nodes[0].devices;
    // 24 total − 4 foreign − 6 ours − 8% headroom
    const headroom = Math.floor(24 * GiB * 0.08);
    expect(Number(device.foreignBytes)).toBe(4 * GiB);
    expect(Number(device.headroomBytes)).toBe(headroom);
    expect(Number(device.availableBytes)).toBe(24 * GiB - 4 * GiB - 6 * GiB - headroom);
    expect(device).toMatchObject({ kind: "DEVICE_KIND_CUDA", pressure: "MEMORY_PRESSURE_NORMAL", schedulable: true });
  });

  it("returns a single node with its devices", async () => {
    const res = await rpc("GetNode", { nodeId });
    expect(res.statusCode).toBe(200);
    expect(res.json().node).toMatchObject({ name: "4090-box", devices: [{ localId: "cuda:0" }] });
  });

  // One indistinguishable outcome, or GetNode becomes a cross-org existence probe.
  it.each([
    ["malformed", () => "not-a-uuid"],
    ["absent", () => randomUUID()],
    ["another org's", () => otherOrgNodeId],
  ])("reports a %s node id as not found", async (_label, id) => {
    expect((await rpc("GetNode", { nodeId: id() })).statusCode).toBe(404);
  });

  it("mints a pairing code for the session's org", async () => {
    const res = await rpc("CreatePairingCode", { nodeName: "mac-studio" });
    expect(res.statusCode).toBe(200);
    expect(res.json().code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(Number(res.json().expiresAtUnixMs)).toBeGreaterThan(Date.now());
  });
});
