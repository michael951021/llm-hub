import { eq } from "drizzle-orm";
import { ownerDb, nodes, organization, withOrg } from "@modelhub/db";
import { redeemPairingCode } from "./pairing.js";

export class EnrollmentError extends Error {
  statusCode = 400;
  code = "enrollment_failed";
}

export interface EnrollInput {
  pairingCode: string;
  publicKey: Uint8Array;
  nodeName: string;
  host: {
    hostname: string; platform: string; arch: string;
    osVersion: string; agentVersion: string;
    totalMemoryBytes: bigint; cpuCores: number;
  };
}

/**
 * True for the Postgres error the driver (postgres.js) throws when the
 * insert below loses a race on nodes_public_key_idx: two enrollments
 * carrying the same public key but two different valid pairing codes can
 * both pass the ownerDb SELECT above (it takes no lock) before either
 * INSERT commits, so the app-level check alone is not sufficient — this
 * is the defense-in-depth backstop for that window. Matches both the
 * unique_violation SQLSTATE and the specific constraint name, not just
 * "an insert on nodes failed": a blanket catch here would relabel a
 * genuine database fault (e.g. a dropped connection) as the client's
 * mistake, which is the same failure mode in the opposite direction.
 */
function isPublicKeyUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null &&
    (err as { code?: unknown }).code === "23505" &&
    (err as { constraint_name?: unknown }).constraint_name === "nodes_public_key_idx"
  );
}

/**
 * Redeems a pairing code and creates the node it names. Unauthenticated by
 * design (see rpc/node-service.ts): the pairing code is what establishes
 * which organization the enrolling machine belongs to.
 */
export async function enrollNode(
  input: EnrollInput,
): Promise<{ nodeId: string; orgId: string; orgName: string }> {
  if (input.publicKey.length !== 32) {
    throw new EnrollmentError("public key must be a 32-byte Ed25519 key");
  }

  // Checked before redeeming the pairing code, and global rather than
  // scoped to any org: one physical machine must not be able to hold
  // identities in two tenants, and a machine that is already enrolled
  // should not burn a fresh, single-use code on an enrollment that was
  // always going to fail — the common case here is a person re-running
  // the agent's enroll command, not an attacker. This is advisory, not
  // the real guarantee: nodes.public_key also carries a unique index, so
  // a race that slips past this check still fails at the insert. Runs on
  // the owner connection for the same reason redeemPairingCode does —
  // there is no org context yet.
  const existing = await ownerDb.select({ id: nodes.id }).from(nodes)
    .where(eq(nodes.publicKey, input.publicKey)).limit(1);
  if (existing.length > 0) {
    throw new EnrollmentError("this key is already enrolled; re-install to get a new identity");
  }

  const { orgId, nodeName } = await redeemPairingCode(input.pairingCode);

  let inserted: { id: string } | undefined;
  try {
    [inserted] = await withOrg(orgId, (tx) =>
      tx.insert(nodes).values({
        orgId,
        name: input.nodeName || nodeName || input.host.hostname || "node",
        status: "offline",
        platform: input.host.platform,
        arch: input.host.arch,
        osVersion: input.host.osVersion,
        agentVersion: input.host.agentVersion,
        hostname: input.host.hostname,
        totalMemoryBytes: input.host.totalMemoryBytes,
        cpuCores: input.host.cpuCores,
        publicKey: input.publicKey,
      }).returning({ id: nodes.id }),
    );
  } catch (err) {
    if (isPublicKeyUniqueViolation(err)) {
      throw new EnrollmentError("this key is already enrolled; re-install to get a new identity");
    }
    throw err;
  }

  const [org] = await ownerDb.select({ name: organization.name })
    .from(organization).where(eq(organization.id, orgId)).limit(1);

  return { nodeId: inserted!.id, orgId, orgName: org?.name ?? "" };
}
