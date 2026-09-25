import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { Code, ConnectError } from "@connectrpc/connect";
import { eq } from "drizzle-orm";
import { isUuid, ownerDb, nodes } from "@modelhub/db";
import { env } from "../env.js";
import { redis } from "../redis.js";

export class NodeAuthError extends ConnectError {
  constructor(message: string) {
    super(message, Code.Unauthenticated);
  }
}

export const NODE_AUTH_SCHEME = "ModelHubNode ";

// DER prefix that turns a raw 32-byte Ed25519 key into SPKI, which is what
// node:crypto verifies against.
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function toKeyObject(raw: Uint8Array): KeyObject {
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(raw)]),
    format: "der",
    type: "spki",
  });
}

/**
 * Verifies `ModelHubNode <nodeId>.<unixMillis>.<nonce>.<signature>`: an
 * Ed25519 signature (base64url) over the first three fields, joined by dots
 * exactly as received. Built by the agent's transport.AuthHeader. Rejects
 * timestamps outside NODE_AUTH_SKEW_MS and any nonce seen before.
 *
 * Runs on ownerDb: which org the node belongs to is this function's output.
 */
export async function authenticateNode(header: string | null): Promise<{ nodeId: string; orgId: string }> {
  if (!header?.startsWith(NODE_AUTH_SCHEME)) throw new NodeAuthError("missing node authorization header");

  const parts = header.slice(NODE_AUTH_SCHEME.length).split(".");
  const [nodeId, millis, nonce, signature] = parts;
  if (parts.length !== 4 || !nodeId || !millis || !nonce || !signature) {
    throw new NodeAuthError("malformed node authorization header");
  }
  if (!isUuid(nodeId)) throw new NodeAuthError("malformed node id");

  const at = Number(millis);
  if (!Number.isFinite(at)) throw new NodeAuthError("malformed timestamp");
  if (Math.abs(Date.now() - at) > env.NODE_AUTH_SKEW_MS) {
    throw new NodeAuthError("timestamp outside the accepted window");
  }

  const [row] = await ownerDb
    .select({ orgId: nodes.orgId, publicKey: nodes.publicKey })
    .from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (!row) throw new NodeAuthError("unknown node");

  // A stored key that doesn't parse is a data problem, not a forgery: say so
  // and log it, but still fail as a clean 401 rather than an OpenSSL 500.
  let key: KeyObject;
  try {
    key = toKeyObject(row.publicKey);
  } catch (err) {
    console.error("[node-auth] stored public key failed to parse", { nodeId, err });
    throw new NodeAuthError("stored node key is invalid");
  }

  let ok = false;
  try {
    ok = verify(null, Buffer.from(`${nodeId}.${millis}.${nonce}`), key, Buffer.from(signature, "base64url"));
  } catch {
    // Unusable signature bytes; same outcome as a signature that doesn't verify.
  }
  if (!ok) throw new NodeAuthError("invalid signature");

  // One nonce, one use, remembered in Redis so replicas share it. Twice the
  // skew window covers any header that could still pass the timestamp check.
  const fresh = await redis.set(`nodeauth:${nodeId}:${nonce}`, "1", "PX", env.NODE_AUTH_SKEW_MS * 2, "NX");
  if (fresh !== "OK") throw new NodeAuthError("replayed authorization header");

  return { nodeId, orgId: row.orgId };
}
