import { and, eq, notInArray } from "drizzle-orm";
import { ownerDb, nodes, organization, withOrg, devices } from "@modelhub/db";
import type { Device, DeviceSample } from "@modelhub/proto";
import { redeemPairingCode } from "./pairing.js";
import { kindName, pressureName, type HostColumns } from "./wire.js";

export class EnrollmentError extends Error {}

export interface EnrollInput {
  pairingCode: string;
  publicKey: Uint8Array;
  nodeName: string;
  host: HostColumns;
}

const ALREADY_ENROLLED = "this key is already enrolled; re-install to get a new identity";

/** The error postgres.js raises when an insert loses the race on nodes_public_key_idx. */
function isPublicKeyUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; constraint_name?: unknown } | null;
  return e?.code === "23505" && e.constraint_name === "nodes_public_key_idx";
}

/**
 * Redeems a pairing code and creates the node it names. Unauthenticated: the
 * pairing code is what establishes which organization the machine joins, so
 * the lookups before the insert run on ownerDb.
 */
export async function enrollNode(
  input: EnrollInput,
): Promise<{ nodeId: string; orgId: string; orgName: string }> {
  if (input.publicKey.length !== 32) {
    throw new EnrollmentError("public key must be a 32-byte Ed25519 key");
  }

  // Checked before redeeming, so re-running enroll on an already-enrolled
  // machine doesn't burn a single-use code. Global, not per org: one machine
  // must not hold identities in two tenants. The unique index is the real
  // guarantee; this check just gives the common case a clean error.
  const [existing] = await ownerDb.select({ id: nodes.id }).from(nodes)
    .where(eq(nodes.publicKey, input.publicKey)).limit(1);
  if (existing) throw new EnrollmentError(ALREADY_ENROLLED);

  const { orgId, nodeName } = await redeemPairingCode(input.pairingCode);

  let nodeId: string;
  try {
    const [row] = await withOrg(orgId, (tx) =>
      tx.insert(nodes).values({
        ...input.host,
        orgId,
        name: input.nodeName || nodeName || input.host.hostname || "node",
        status: "offline",
        publicKey: input.publicKey,
      }).returning({ id: nodes.id }),
    );
    nodeId = row!.id;
  } catch (err) {
    if (isPublicKeyUniqueViolation(err)) throw new EnrollmentError(ALREADY_ENROLLED);
    throw err;
  }

  const [org] = await ownerDb.select({ name: organization.name })
    .from(organization).where(eq(organization.id, orgId)).limit(1);
  return { nodeId, orgId, orgName: org?.name ?? "" };
}

/** Marks a node online and refreshes the host facts from its Hello. */
export async function markNodeOnline(orgId: string, nodeId: string, host: HostColumns): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx.update(nodes).set({ ...host, status: "online", lastSeenAt: new Date() })
      .where(eq(nodes.id, nodeId)),
  );
}

/**
 * Upserts the devices a node reports and deletes the ones it no longer does,
 * so a vanished GPU stops being schedulable. An empty report deletes them all.
 *
 * A device with an unrecognized kind is dropped, not stored as "cpu": a
 * guessed kind would be indistinguishable from a real one forever, while a
 * dropped device reappears once a control plane that knows the kind sees it.
 */
export async function recordInventory(orgId: string, nodeId: string, reported: Device[]): Promise<void> {
  const known = reported.flatMap((d) => {
    const kind = kindName(d.kind);
    if (kind) return [{ ...d, kind }];
    console.warn("[inventory] skipping a device with an unrecognized kind", { nodeId, localId: d.localId, kind: d.kind });
    return [];
  });

  await withOrg(orgId, async (tx) => {
    for (const d of known) {
      const facts = {
        kind: d.kind, index: d.index, name: d.name, totalBytes: d.totalBytes,
        wiredLimitBytes: d.wiredLimitBytes, driverVersion: d.driverVersion,
        computeCapability: d.computeCapability,
      };
      await tx.insert(devices).values({ ...facts, orgId, nodeId, localId: d.localId })
        .onConflictDoUpdate({ target: [devices.nodeId, devices.localId], set: facts });
    }

    const keep = known.map((d) => d.localId);
    await tx.delete(devices).where(keep.length > 0
      ? and(eq(devices.nodeId, nodeId), notInArray(devices.localId, keep))
      : eq(devices.nodeId, nodeId));
  });
}

/**
 * Applies a batch of samples and refreshes the node's lastSeenAt. An empty
 * batch still counts as a heartbeat.
 *
 * Unlike an unknown device kind, an unknown pressure is recorded as "normal"
 * (and logged): a sample is transient, and reading it as "warn" would take
 * capacity out of the fleet over mere version skew.
 */
export async function recordSamples(orgId: string, nodeId: string, samples: DeviceSample[]): Promise<void> {
  await withOrg(orgId, async (tx) => {
    for (const s of samples) {
      const pressure = pressureName(s.pressure);
      if (!pressure) {
        console.warn("[samples] unrecognized memory pressure; recording normal", { nodeId, localId: s.localId, pressure: s.pressure });
      }
      await tx.update(devices).set({
        lastUsedBytes: s.usedBytes,
        lastManagedBytes: s.managedBytes,
        lastUtilization: s.utilization,
        lastPressure: pressure ?? "normal",
        lastSampleAt: new Date(Number(s.sampledAtUnixMs)),
      }).where(and(eq(devices.nodeId, nodeId), eq(devices.localId, s.localId)));
    }
    await tx.update(nodes).set({ lastSeenAt: new Date(), status: "online" }).where(eq(nodes.id, nodeId));
  });
}
