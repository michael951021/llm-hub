import { createPublicKey, verify, sign, randomUUID, type KeyObject } from "node:crypto";
import { eq } from "drizzle-orm";
import { ownerDb, nodes } from "@modelhub/db";
import { env } from "../env.js";
import { redis } from "../redis.js";

export class NodeAuthError extends Error {
  statusCode = 401;
  code = "node_unauthenticated";
}

const PREFIX = "ModelHubNode ";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Node's crypto verifies Ed25519 against a KeyObject, so wrap the raw 32 bytes
// in the fixed SPKI prefix for Ed25519 rather than pulling in a dependency.
// Confirmed against a real generateKeyPairSync("ed25519") key: this constant
// concatenated with the last 32 bytes of a real SPKI DER export reproduces
// that export byte-for-byte.
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function toKeyObject(raw: Uint8Array) {
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(raw)]),
    format: "der",
    type: "spki",
  });
}

/**
 * Builds the wire-format Authorization header value for a node's outgoing
 * request. Mirrored byte-for-byte in Go by Task 15 — the payload signed is
 * "<nodeId>.<unixMillis>.<nonceBase64Url>", and every field is base64url
 * (unpadded on the Go side; Node's decoder accepts both).
 */
export function buildNodeAuthHeader(
  nodeId: string,
  privateKey: KeyObject,
  atMs: number = Date.now(),
  nonce: string = randomUUID(),
): string {
  const n = Buffer.from(nonce).toString("base64url");
  const payload = `${nodeId}.${atMs}.${n}`;
  const sig = sign(null, Buffer.from(payload), privateKey).toString("base64url");
  return `${PREFIX}${payload}.${sig}`;
}

export async function authenticateNode(
  headerValue: string | undefined,
): Promise<{ nodeId: string; orgId: string }> {
  if (!headerValue || !headerValue.startsWith(PREFIX)) {
    throw new NodeAuthError("missing node authorization header");
  }

  const parts = headerValue.slice(PREFIX.length).split(".");
  if (parts.length !== 4) throw new NodeAuthError("malformed node authorization header");
  const [nodeId, millis, nonce, signature] = parts as [string, string, string, string];
  if (!nodeId || !millis || !nonce || !signature) {
    throw new NodeAuthError("malformed node authorization header");
  }
  // nodes.id is a Postgres uuid column: an eq() comparison against a
  // non-uuid string throws a raw driver error rather than returning no
  // rows, so a malformed-but-4-part node id must be rejected here before
  // it ever reaches the query.
  if (!UUID_RE.test(nodeId)) {
    throw new NodeAuthError("malformed node id");
  }

  const at = Number(millis);
  if (!Number.isFinite(at)) throw new NodeAuthError("malformed timestamp");
  if (Math.abs(Date.now() - at) > env.NODE_AUTH_SKEW_MS) {
    throw new NodeAuthError("timestamp outside the accepted window");
  }

  // The node lookup runs on ownerDb, deliberately: an agent presenting this
  // header has no session and no org context yet — which org it belongs to
  // is the *output* of this function, not an input, so it cannot be routed
  // through withOrg().
  const [row] = await ownerDb
    .select({ id: nodes.id, orgId: nodes.orgId, publicKey: nodes.publicKey })
    .from(nodes)
    .where(eq(nodes.id, nodeId))
    .limit(1);
  if (!row) throw new NodeAuthError("unknown node");

  // Key reconstruction and verification are wrapped narrowly -- just this,
  // not the DB/Redis calls around it -- because a stored public key that
  // doesn't round-trip through the fixed SPKI prefix (corrupted row, future
  // migration bug, manual edit) throws a raw OpenSSL error rather than
  // returning false. This sits in front of a public, unauthenticated
  // endpoint, so that must still come out as a clean NodeAuthError, not an
  // unmapped 500 -- but it is a data problem, not a forged-signature
  // problem, so it gets its own message and is logged with the node id:
  // silently reading it as "unauthenticated" would hide a corrupted row
  // forever.
  let keyObject: KeyObject;
  try {
    keyObject = toKeyObject(row.publicKey);
  } catch (err) {
    console.error("[node-auth] stored public key failed to parse", { nodeId: row.id, err });
    throw new NodeAuthError("stored node key is invalid");
  }

  let ok: boolean;
  try {
    ok = verify(
      null,
      Buffer.from(`${nodeId}.${millis}.${nonce}`),
      keyObject,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    // Distinct from the stored-key case above: the key parsed fine, so a
    // throw here means the *supplied* signature bytes were unusable, which
    // is just a more emphatic way for a bad signature to fail than
    // verify() returning false.
    throw new NodeAuthError("invalid signature");
  }
  if (!ok) throw new NodeAuthError("invalid signature");

  // One nonce, one use. The replay cache lives in Redis, not an in-process
  // Map, because the control plane is stateless across replicas by design.
  // TTL is twice the skew window: that is exactly how long a nonce presented
  // right at the edge of the window could still fall inside it on retry.
  const fresh = await redis.set(
    `nodeauth:${nodeId}:${nonce}`,
    "1",
    "PX",
    env.NODE_AUTH_SKEW_MS * 2,
    "NX",
  );
  if (fresh !== "OK") throw new NodeAuthError("replayed authorization header");

  return { nodeId: row.id, orgId: row.orgId };
}
