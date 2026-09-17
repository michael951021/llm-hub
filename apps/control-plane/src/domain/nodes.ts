import { and, eq, notInArray } from "drizzle-orm";
import { ownerDb, nodes, organization, withOrg, devices } from "@modelhub/db";
import { DeviceKind, MemoryPressure, type Device, type DeviceSample } from "@modelhub/proto";
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

const KIND_NAMES: Record<number, string> = {
  [DeviceKind.CPU]: "cpu",
  [DeviceKind.CUDA]: "cuda",
  [DeviceKind.METAL]: "metal",
};
const PRESSURE_NAMES: Record<number, string> = {
  [MemoryPressure.NORMAL]: "normal",
  [MemoryPressure.WARN]: "warn",
  [MemoryPressure.CRITICAL]: "critical",
};

/**
 * Upserts the devices a node reports on this connection and deletes the
 * ones it no longer reports. A device that vanished — a GPU pulled out, or
 * a driver that stopped enumerating it — must stop being schedulable
 * rather than linger as a stale, unreachable row. When `reported` is
 * empty, every device row for this node is deleted: silence about devices
 * is itself the report "this node has none right now", not a no-op.
 *
 * Scoped to (nodeId, orgId) throughout via withOrg's RLS context and an
 * explicit nodeId predicate on the delete, so this can never touch another
 * node's — or another org's — rows.
 */
export async function recordInventory(
  orgId: string, nodeId: string, reported: Device[],
): Promise<void> {
  // Resolve every kind first, and drop the ones this build does not
  // recognize. A device whose kind is unknown is NOT recorded as a cpu: the
  // agent maps an unrecognized kind to DEVICE_KIND_UNSPECIFIED deliberately
  // (agent/internal/transport/session.go) so that it fails visibly, and
  // writing "cpu" here would launder that signal at the database boundary
  // into a row indistinguishable from a real CPU — no query can find it
  // afterwards and no migration can repair it, because nothing in the row
  // records that the kind was invented. Dropping is the recoverable
  // alternative: the device reappears on the next inventory once a control
  // plane that knows the kind reads it.
  //
  // The filter runs once, up front, so a dropped device also stays out of
  // `keep` below and is not resurrected by the reconcile.
  const known: { device: Device; kind: string }[] = [];
  for (const d of reported) {
    const kind = KIND_NAMES[d.kind];
    if (kind === undefined) {
      console.warn("[inventory] skipping a device with an unrecognized kind", {
        orgId, nodeId, localId: d.localId, kind: d.kind,
      });
      continue;
    }
    known.push({ device: d, kind });
  }

  await withOrg(orgId, async (tx) => {
    for (const { device: d, kind } of known) {
      const values = {
        orgId, nodeId,
        localId: d.localId,
        kind,
        index: d.index,
        name: d.name,
        totalBytes: d.totalBytes,
        wiredLimitBytes: d.wiredLimitBytes,
        driverVersion: d.driverVersion,
        computeCapability: d.computeCapability,
      };
      await tx.insert(devices).values(values).onConflictDoUpdate({
        target: [devices.nodeId, devices.localId],
        set: {
          kind: values.kind,
          index: values.index,
          name: values.name,
          totalBytes: values.totalBytes,
          wiredLimitBytes: values.wiredLimitBytes,
          driverVersion: values.driverVersion,
          computeCapability: values.computeCapability,
        },
      });
    }

    const keep = known.map(({ device }) => device.localId);
    await tx.delete(devices).where(
      keep.length > 0
        ? and(eq(devices.nodeId, nodeId), notInArray(devices.localId, keep))
        : eq(devices.nodeId, nodeId),
    );
  });
}

/**
 * Applies a batch of device samples and marks the node as having just been
 * seen. A no-op on an empty batch: an empty SampleBatch is not a claim
 * that the node has no devices (recordInventory owns that claim), so it
 * must not touch any device row — but the node itself is still alive, so
 * whether the samples list is empty is irrelevant to lastSeenAt in the
 * stream handler, which calls this once per SampleBatch message.
 */
export async function recordSamples(
  orgId: string, nodeId: string, samples: DeviceSample[],
): Promise<void> {
  await withOrg(orgId, async (tx) => {
    for (const s of samples) {
      // Unlike an unknown device kind, an unknown pressure is recorded as
      // "normal" rather than dropped: a sample is a transient reading, and
      // reading unknown as "warn" would take real capacity out of the fleet
      // on nothing more than version skew between agent and server. It is
      // still logged — this is a wire-contract mismatch, and silently
      // calling it "normal" is exactly how it would stay invisible.
      const pressure = PRESSURE_NAMES[s.pressure];
      if (pressure === undefined) {
        console.warn("[samples] unrecognized memory pressure; recording it as normal", {
          orgId, nodeId, localId: s.localId, pressure: s.pressure,
        });
      }
      await tx.update(devices).set({
        lastUsedBytes: s.usedBytes,
        lastManagedBytes: s.managedBytes,
        lastUtilization: s.utilization,
        lastPressure: pressure ?? "normal",
        lastSampleAt: new Date(Number(s.sampledAtUnixMs)),
      }).where(and(eq(devices.nodeId, nodeId), eq(devices.localId, s.localId)));
    }
    await tx.update(nodes)
      .set({ lastSeenAt: new Date(), status: "online" })
      .where(eq(nodes.id, nodeId));
  });
}

/**
 * Marks a node online and refreshes the host facts it just reported over
 * `Hello`. Called once at the start of each Connect stream.
 */
export async function markNodeOnline(
  orgId: string, nodeId: string, host: EnrollInput["host"],
): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx.update(nodes).set({
      status: "online",
      lastSeenAt: new Date(),
      agentVersion: host.agentVersion,
      platform: host.platform,
      arch: host.arch,
      osVersion: host.osVersion,
      hostname: host.hostname,
      totalMemoryBytes: host.totalMemoryBytes,
      cpuCores: host.cpuCores,
    }).where(eq(nodes.id, nodeId)),
  );
}
