// Fixtures shared by the control plane's integration tests (and e2e). Tests
// run against a persistent dev database, so every fixture is freshly random.
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import type { FastifyInstance, RawServerBase } from "fastify";
import { nodes, organization, ownerDb } from "@modelhub/db";
import { NODE_AUTH_SCHEME } from "./rpc/node-auth.js";

export const GiB = 1024 ** 3;

export async function createOrg(name = "Test Org"): Promise<string> {
  const id = `org_${randomUUID().slice(0, 8)}`;
  // organization.createdAt has no DB default; Better Auth always sets it.
  await ownerDb.insert(organization).values({ id, name, slug: id, createdAt: new Date() });
  return id;
}

/** A fresh Ed25519 key pair; publicKey is the raw 32 bytes nodes.public_key holds. */
export function newNodeKey(): { privateKey: KeyObject; publicKey: Uint8Array } {
  const pair = generateKeyPairSync("ed25519");
  const der = pair.publicKey.export({ format: "der", type: "spki" });
  return { privateKey: pair.privateKey, publicKey: new Uint8Array(der.subarray(der.length - 32)) };
}

export async function createNode(
  orgId: string, values: Partial<typeof nodes.$inferInsert> = {},
): Promise<{ nodeId: string; privateKey: KeyObject }> {
  const { privateKey, publicKey } = newNodeKey();
  const [row] = await ownerDb.insert(nodes)
    .values({ orgId, name: "node", publicKey, ...values })
    .returning({ id: nodes.id });
  return { nodeId: row!.id, privateKey };
}

/** The same header the agent's transport.AuthHeader builds. */
export function nodeAuthHeader(
  nodeId: string, privateKey: KeyObject, atMs = Date.now(), nonce = randomUUID(),
): string {
  const payload = `${nodeId}.${atMs}.${Buffer.from(nonce).toString("base64url")}`;
  return `${NODE_AUTH_SCHEME}${payload}.${sign(null, Buffer.from(payload), privateKey).toString("base64url")}`;
}

/** Signs up a fresh user through Better Auth; returns their cookie and personal org. */
export async function signUp(app: FastifyInstance, email = `t-${randomUUID()}@example.com`) {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email, password: "correct-horse-battery", name: "Test User" },
  });
  if (res.statusCode >= 400) throw new Error(`sign-up failed: ${res.statusCode} ${res.body}`);
  const raw = res.headers["set-cookie"];
  const cookie = Array.isArray(raw) ? raw.join("; ") : String(raw);
  const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
  return { cookie, email, orgId: me.json().org.id as string };
}

/** Listens on an ephemeral loopback port and returns the base URL. */
export async function listen(app: FastifyInstance<RawServerBase, any, any, any>): Promise<string> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("no port bound");
  return `http://127.0.0.1:${address.port}`;
}
