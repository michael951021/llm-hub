import { describe, expect, it } from "vitest";
import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import { DeviceKind, DeviceSchema, MemoryPressure } from "./index.js";

describe("generated protobuf", () => {
  it("round-trips a Device through binary encoding", () => {
    const device = create(DeviceSchema, {
      localId: "cuda:0",
      kind: DeviceKind.CUDA,
      index: 0,
      name: "NVIDIA GeForce RTX 4090",
      totalBytes: 25_769_803_776n,
    });

    const decoded = fromBinary(DeviceSchema, toBinary(DeviceSchema, device));

    expect(decoded.localId).toBe("cuda:0");
    expect(decoded.kind).toBe(DeviceKind.CUDA);
    expect(decoded.totalBytes).toBe(25_769_803_776n);
  });

  it("exposes the memory pressure enum", () => {
    expect(MemoryPressure.CRITICAL).toBeDefined();
  });
});
