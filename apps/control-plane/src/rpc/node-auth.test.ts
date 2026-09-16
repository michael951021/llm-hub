import { beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSync, randomBytes, sign, randomUUID, type KeyObject } from "node:crypto";
import { ownerDb, organization, nodes } from "@modelhub/db";
import { authenticateNode, NodeAuthError } from "./node-auth.js";

const orgId = `org_${randomUUID().slice(0, 8)}`;
let nodeId: string;
let privateKey: KeyObject;

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");

function header(id: string, key: KeyObject, atMs = Date.now(), nonce = randomUUID()): string {
  const n = b64u(Buffer.from(nonce));
  const payload = `${id}.${atMs}.${n}`;
  const sig = b64u(sign(null, Buffer.from(payload), key));
  return `ModelHubNode ${payload}.${sig}`;
}

beforeAll(async () => {
  const pair = generateKeyPairSync("ed25519");
  privateKey = pair.privateKey;
  const der = pair.publicKey.export({ format: "der", type: "spki" }) as Buffer;

  await ownerDb.insert(organization).values({ id: orgId, name: "Auth", slug: orgId, createdAt: new Date() });
  const [row] = await ownerDb.insert(nodes).values({
    orgId, name: "signer", publicKey: new Uint8Array(der.subarray(der.length - 32)),
  }).returning({ id: nodes.id });
  nodeId = row!.id;
});

describe("node authentication", () => {
  it("accepts a correctly signed header", async () => {
    const ctx = await authenticateNode(header(nodeId, privateKey));
    expect(ctx).toEqual({ nodeId, orgId });
  });

  it("rejects a missing header", async () => {
    await expect(authenticateNode(undefined)).rejects.toThrow(NodeAuthError);
  });

  it("rejects a signature made with the wrong key", async () => {
    const { privateKey: other } = generateKeyPairSync("ed25519");
    await expect(authenticateNode(header(nodeId, other))).rejects.toThrow(/signature/i);
  });

  it("rejects a timestamp outside the skew window", async () => {
    const stale = Date.now() - 10 * 60_000;
    await expect(authenticateNode(header(nodeId, privateKey, stale))).rejects.toThrow(/timestamp/i);
  });

  it("rejects a future-dated timestamp outside the skew window", async () => {
    const future = Date.now() + 10 * 60_000;
    await expect(authenticateNode(header(nodeId, privateKey, future))).rejects.toThrow(/timestamp/i);
  });

  it("rejects a replayed nonce", async () => {
    const nonce = randomUUID();
    const h = header(nodeId, privateKey, Date.now(), nonce);
    await authenticateNode(h);
    await expect(authenticateNode(h)).rejects.toThrow(/replay/i);
  });

  it("rejects an unknown node id", async () => {
    await expect(
      authenticateNode(header(randomUUID(), privateKey)),
    ).rejects.toThrow(NodeAuthError);
  });

  it("rejects a malformed header", async () => {
    await expect(authenticateNode("ModelHubNode garbage")).rejects.toThrow(NodeAuthError);
  });

  it("fails safely, as NodeAuthError, when the stored public key is corrupted", async () => {
    // Not attacker-reachable through the header -- the attacker doesn't
    // control the database row -- but a corrupted/wrong-length stored key
    // (bad migration, manual edit) must still come out as a clean auth
    // failure rather than an unmapped OpenSSL error, since this sits in
    // front of a public, unauthenticated endpoint.
    // Random, not all-zero: nodes.public_key is uniquely indexed, and a
    // fixed value would collide with the same row inserted by a previous
    // run of this test against a persistent dev database.
    const [row] = await ownerDb.insert(nodes).values({
      orgId, name: "corrupted", publicKey: randomBytes(16), // wrong length
    }).returning({ id: nodes.id });
    const corruptedNodeId = row!.id;

    await expect(
      authenticateNode(header(corruptedNodeId, privateKey)),
    ).rejects.toThrow(NodeAuthError);
  });
});
