import { computeBudget, type DeviceKind, type MemoryPressure } from "@modelhub/core";

const KIND_ENUM: Record<string, number> = { cpu: 1, cuda: 2, metal: 3 };
const PRESSURE_ENUM: Record<string, number> = { normal: 1, warn: 2, critical: 3 };

export interface DeviceRow {
  id: string; localId: string; kind: string; name: string;
  totalBytes: bigint; wiredLimitBytes: bigint; interactive: boolean;
  lastUsedBytes: bigint; lastManagedBytes: bigint;
  lastUtilization: number; lastPressure: string;
}

export interface NodeRow {
  id: string; name: string; status: string;
  hostname: string; platform: string; arch: string;
  osVersion: string; agentVersion: string;
  totalMemoryBytes: bigint; cpuCores: number;
  lastSeenAt: Date | null;
}

export function buildDeviceView(d: DeviceRow) {
  const budget = computeBudget({
    kind: d.kind as DeviceKind,
    totalBytes: Number(d.totalBytes),
    usedBytes: Number(d.lastUsedBytes),
    managedBytes: Number(d.lastManagedBytes),
    wiredLimitBytes: Number(d.wiredLimitBytes),
    pressure: d.lastPressure as MemoryPressure,
    interactive: d.interactive,
  });

  return {
    id: d.id,
    localId: d.localId,
    kind: KIND_ENUM[d.kind] ?? 0,
    name: d.name,
    totalBytes: BigInt(budget.totalBytes),
    managedBytes: BigInt(budget.managedBytes),
    foreignBytes: BigInt(budget.foreignBytes),
    headroomBytes: BigInt(budget.headroomBytes),
    availableBytes: BigInt(budget.availableBytes),
    utilization: d.lastUtilization,
    pressure: PRESSURE_ENUM[d.lastPressure] ?? 1,
    schedulable: budget.schedulable,
  };
}

export function buildNodeView(n: NodeRow, deviceRows: DeviceRow[]) {
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
    devices: deviceRows.map(buildDeviceView),
  };
}
