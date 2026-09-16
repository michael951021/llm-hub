import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { appSql, ownerSql, ownerDb, organization, nodes } from "@modelhub/db";
import { eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import { mintPairingCode } from "../domain/pairing.js";
import { redis } from "../redis.js";

let app: FastifyInstance;
const orgId = `org_${randomUUID().slice(0, 8)}`;

function newPublicKey(): Uint8Array {
  const { publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32)); // raw 32-byte key
}

beforeAll(async () => {
  // organization.createdAt has no DB-side default (see rls.test.ts /
  // pairing.test.ts) so a direct insert must supply it.
  await ownerDb.insert(organization).values({ id: orgId, name: "Fleet", slug: orgId, createdAt: new Date() });
  app = await buildApp();
});
afterAll(async () => {
  await app.close();
  await redis.quit();
  await appSql.end();
  await ownerSql.end();
});

async function enroll(body: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/modelhub.v1.NodeService/Enroll",
    headers: { "content-type": "application/json" },
    payload: body,
  });
}

describe("NodeService.Enroll", () => {
  it("creates a node bound to the code's organization", async () => {
    const { code } = await mintPairingCode(orgId, "user_1", "mac-studio");
    const publicKey = newPublicKey();

    const res = await enroll({
      pairingCode: code,
      publicKey: Buffer.from(publicKey).toString("base64"),
      nodeName: "mac-studio",
      host: {
        hostname: "mac-studio.local", platform: "darwin", arch: "arm64",
        osVersion: "15.0", agentVersion: "0.1.0",
        totalMemoryBytes: "137438953472", cpuCores: 24,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.orgId).toBe(orgId);
    expect(body.nodeId).toBeTruthy();

    const [row] = await ownerDb.select().from(nodes).where(eq(nodes.id, body.nodeId));
    expect(row!.orgId).toBe(orgId);
    expect(row!.platform).toBe("darwin");
    expect(Buffer.from(row!.publicKey)).toEqual(Buffer.from(publicKey));
  });

  it("rejects an invalid pairing code", async () => {
    const res = await enroll({
      pairingCode: "ZZZZ-ZZZZ",
      publicKey: Buffer.from(newPublicKey()).toString("base64"),
      nodeName: "nope",
      host: { hostname: "h", platform: "linux", arch: "amd64" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("rejects a public key that is not 32 bytes", async () => {
    const { code } = await mintPairingCode(orgId, "user_1", "bad-key");
    const res = await enroll({
      pairingCode: code,
      publicKey: Buffer.from(new Uint8Array(16)).toString("base64"),
      nodeName: "bad-key",
      host: { hostname: "h", platform: "linux", arch: "amd64" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("rejects a public key already registered to another node", async () => {
    const publicKey = newPublicKey();
    const first = await mintPairingCode(orgId, "user_1", "n1");
    const second = await mintPairingCode(orgId, "user_1", "n2");
    const payload = (code: string) => ({
      pairingCode: code,
      publicKey: Buffer.from(publicKey).toString("base64"),
      nodeName: "dup",
      host: { hostname: "h", platform: "linux", arch: "amd64" },
    });

    expect((await enroll(payload(first.code))).statusCode).toBe(200);
    expect((await enroll(payload(second.code))).statusCode).toBeGreaterThanOrEqual(400);
  });

  it("does not consume the pairing code when enrollment fails on a duplicate key", async () => {
    const registeredKey = newPublicKey();
    const freshKey = newPublicKey();

    // Register registeredKey once so it is a genuine duplicate on the next attempt.
    const setup = await mintPairingCode(orgId, "user_1", "already-enrolled");
    expect((await enroll({
      pairingCode: setup.code,
      publicKey: Buffer.from(registeredKey).toString("base64"),
      nodeName: "already-enrolled",
      host: { hostname: "h", platform: "linux", arch: "amd64" },
    })).statusCode).toBe(200);

    const { code } = await mintPairingCode(orgId, "user_1", "retry");

    const rejected = await enroll({
      pairingCode: code,
      publicKey: Buffer.from(registeredKey).toString("base64"),
      nodeName: "retry",
      host: { hostname: "h", platform: "linux", arch: "amd64" },
    });
    expect(rejected.statusCode).toBeGreaterThanOrEqual(400);

    // The code must not have been burned by the failed attempt above: it
    // should still redeem successfully for a different, unregistered key.
    const accepted = await enroll({
      pairingCode: code,
      publicKey: Buffer.from(freshKey).toString("base64"),
      nodeName: "retry",
      host: { hostname: "h", platform: "linux", arch: "amd64" },
    });
    expect(accepted.statusCode).toBe(200);
  });
});
