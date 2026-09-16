import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DeviceMemoryBar } from "./DeviceMemoryBar.js";

const GiB = 1024 ** 3;

const device = {
  id: "d1", localId: "cuda:0", kind: 2, name: "NVIDIA GeForce RTX 4090",
  totalBytes: BigInt(24 * GiB),
  managedBytes: BigInt(6 * GiB),
  foreignBytes: BigInt(4 * GiB),
  headroomBytes: BigInt(2 * GiB),
  availableBytes: BigInt(12 * GiB),
  utilization: 0.5, pressure: 1, schedulable: true,
};

describe("DeviceMemoryBar", () => {
  it("shows managed, foreign, and available as distinct, labeled segments", () => {
    render(<DeviceMemoryBar device={device} />);

    expect(screen.getByTestId("segment-managed")).toHaveAttribute("data-bytes", String(6 * GiB));
    expect(screen.getByTestId("segment-foreign")).toHaveAttribute("data-bytes", String(4 * GiB));
    expect(screen.getByTestId("segment-available")).toHaveAttribute("data-bytes", String(12 * GiB));
  });

  it("states the available capacity in words", () => {
    render(<DeviceMemoryBar device={device} />);
    expect(screen.getByText(/12\.0 GiB available/)).toBeInTheDocument();
  });

  it("explains why a device is not schedulable", () => {
    render(<DeviceMemoryBar device={{ ...device, schedulable: false, pressure: 2 }} />);
    expect(screen.getByText(/under memory pressure/i)).toBeInTheDocument();
  });

  it("does not divide by zero on a device reporting no memory", () => {
    render(<DeviceMemoryBar device={{ ...device, totalBytes: 0n, availableBytes: 0n }} />);
    expect(screen.getByTestId("segment-available")).toHaveStyle({ width: "0%" });
  });
});
