import { describe, expect, it } from "vitest";
import { DeviceKind, MemoryPressure } from "@modelhub/proto";
import { GiB } from "../test-helpers.js";
import { deviceView, hostColumns, kindName, pressureName } from "./wire.js";

describe("wire mapping", () => {
  it("maps known enums to names and everything else to undefined", () => {
    expect(kindName(DeviceKind.METAL)).toBe("metal");
    expect(kindName(DeviceKind.UNSPECIFIED)).toBeUndefined();
    expect(kindName(99 as DeviceKind)).toBeUndefined();
    expect(pressureName(MemoryPressure.CRITICAL)).toBe("critical");
    expect(pressureName(MemoryPressure.UNSPECIFIED)).toBeUndefined();
  });

  it("fills every host column even when the message carries no host", () => {
    expect(hostColumns(undefined)).toEqual({
      hostname: "", platform: "", arch: "", osVersion: "", agentVersion: "",
      totalMemoryBytes: 0n, cpuCores: 0,
    });
  });

  it("builds a device view with the budget computed and enums restored", () => {
    const view = deviceView({
      id: "d1", orgId: "o", nodeId: "n", localId: "metal:0", kind: "metal", index: 0,
      name: "M2 Ultra", totalBytes: BigInt(128 * GiB), wiredLimitBytes: BigInt(96 * GiB),
      driverVersion: "", computeCapability: "", interactive: false,
      lastUsedBytes: BigInt(20 * GiB), lastManagedBytes: BigInt(16 * GiB), lastUtilization: 0.1,
      lastPressure: "warn", lastSampleAt: null, createdAt: new Date(),
    });
    expect(view).toMatchObject({
      kind: DeviceKind.METAL, pressure: MemoryPressure.WARN,
      foreignBytes: BigInt(4 * GiB), availableBytes: 0n, schedulable: false,
    });
  });
});
