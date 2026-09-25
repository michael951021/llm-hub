// Translation between the protobuf contract and database rows. Proto enums
// travel on the wire; the database stores lowercase names.
import { computeBudget, type DeviceKind as KindName, type MemoryPressure as PressureName } from "@modelhub/core";
import type { devices, nodes } from "@modelhub/db";
import { DeviceKind, MemoryPressure, type HostInfo } from "@modelhub/proto";

const KINDS: Record<KindName, DeviceKind> = {
  cpu: DeviceKind.CPU, cuda: DeviceKind.CUDA, metal: DeviceKind.METAL,
};
const PRESSURES: Record<PressureName, MemoryPressure> = {
  normal: MemoryPressure.NORMAL, warn: MemoryPressure.WARN, critical: MemoryPressure.CRITICAL,
};

const nameOf = <N extends string, V>(table: Record<N, V>, value: V): N | undefined =>
  (Object.keys(table) as N[]).find((name) => table[name] === value);

/** undefined for UNSPECIFIED or a kind this build doesn't know. */
export const kindName = (kind: DeviceKind) => nameOf(KINDS, kind);
export const pressureName = (pressure: MemoryPressure) => nameOf(PRESSURES, pressure);

/** The `nodes` columns a HostInfo fills in. */
export function hostColumns(host: HostInfo | undefined) {
  return {
    hostname: host?.hostname ?? "",
    platform: host?.platform ?? "",
    arch: host?.arch ?? "",
    osVersion: host?.osVersion ?? "",
    agentVersion: host?.agentVersion ?? "",
    totalMemoryBytes: host?.totalMemoryBytes ?? 0n,
    cpuCores: host?.cpuCores ?? 0,
  };
}
export type HostColumns = ReturnType<typeof hostColumns>;

type DeviceRow = typeof devices.$inferSelect;
type NodeRow = typeof nodes.$inferSelect;

/** A DeviceView with its memory budget computed; the browser does no arithmetic. */
export function deviceView(d: DeviceRow) {
  const budget = computeBudget({
    kind: d.kind as KindName,
    totalBytes: Number(d.totalBytes),
    usedBytes: Number(d.lastUsedBytes),
    managedBytes: Number(d.lastManagedBytes),
    wiredLimitBytes: Number(d.wiredLimitBytes),
    pressure: d.lastPressure as PressureName,
    interactive: d.interactive,
  });
  return {
    id: d.id,
    localId: d.localId,
    kind: KINDS[d.kind as KindName] ?? DeviceKind.UNSPECIFIED,
    name: d.name,
    totalBytes: BigInt(budget.totalBytes),
    managedBytes: BigInt(budget.managedBytes),
    foreignBytes: BigInt(budget.foreignBytes),
    headroomBytes: BigInt(budget.headroomBytes),
    availableBytes: BigInt(budget.availableBytes),
    utilization: d.lastUtilization,
    pressure: PRESSURES[d.lastPressure as PressureName] ?? MemoryPressure.NORMAL,
    schedulable: budget.schedulable,
  };
}

export function nodeView(n: NodeRow, deviceRows: DeviceRow[]) {
  return {
    id: n.id,
    name: n.name,
    status: n.status,
    lastSeenUnixMs: BigInt(n.lastSeenAt?.getTime() ?? 0),
    host: {
      hostname: n.hostname, platform: n.platform, arch: n.arch,
      osVersion: n.osVersion, agentVersion: n.agentVersion,
      totalMemoryBytes: n.totalMemoryBytes, cpuCores: n.cpuCores,
    },
    devices: deviceRows.map(deviceView),
  };
}
