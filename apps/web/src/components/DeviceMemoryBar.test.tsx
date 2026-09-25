import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { create } from "@bufbuild/protobuf";
import { DeviceKind, DeviceViewSchema, MemoryPressure, type DeviceView } from "@modelhub/proto";
import { DeviceMemoryBar } from "./DeviceMemoryBar.js";

const GiB = 1024 ** 3;

const device = (overrides: Partial<DeviceView> = {}): DeviceView => ({
  ...create(DeviceViewSchema, {
    id: "d1", localId: "cuda:0", kind: DeviceKind.CUDA, name: "NVIDIA GeForce RTX 4090",
    totalBytes: BigInt(24 * GiB), managedBytes: BigInt(6 * GiB), foreignBytes: BigInt(4 * GiB),
    headroomBytes: BigInt(2 * GiB), availableBytes: BigInt(12 * GiB),
    utilization: 0.5, pressure: MemoryPressure.NORMAL, schedulable: true,
  }),
  ...overrides,
});

describe("DeviceMemoryBar", () => {
  it("sizes managed, foreign, headroom, and available as distinct segments", () => {
    render(<DeviceMemoryBar device={device()} />);
    expect(screen.getByTestId("segment-managedBytes")).toHaveStyle({ width: "25%" });
    expect(screen.getByTestId("segment-foreignBytes")).toHaveAttribute("data-bytes", String(4 * GiB));
    expect(screen.getByTestId("segment-headroomBytes")).toHaveAttribute("data-bytes", String(2 * GiB));
    expect(screen.getByTestId("segment-availableBytes")).toHaveStyle({ width: "50%" });
  });

  it("states the available capacity in words", () => {
    render(<DeviceMemoryBar device={device()} />);
    expect(screen.getByText("12.0 GiB available of 24.0 GiB total")).toBeInTheDocument();
  });

  it("explains why a device is not schedulable", () => {
    render(<DeviceMemoryBar device={device({ schedulable: false, pressure: MemoryPressure.WARN })} />);
    expect(screen.getByText(/under memory pressure/i)).toBeInTheDocument();
  });

  it("does not divide by zero on a device reporting no memory", () => {
    render(<DeviceMemoryBar device={device({ totalBytes: 0n, availableBytes: 0n })} />);
    expect(screen.getByTestId("segment-availableBytes")).toHaveStyle({ width: "0%" });
  });
});
