import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { NodeCard } from "./NodeCard.js";

const node = {
  id: "n1", name: "4090-box", status: "online",
  lastSeenUnixMs: BigInt(Date.now() - 2_000),
  host: {
    hostname: "tower", platform: "linux", arch: "amd64",
    osVersion: "6.8", agentVersion: "0.1.0",
    totalMemoryBytes: BigInt(64 * 1024 ** 3), cpuCores: 16,
  },
  devices: [],
};

describe("NodeCard", () => {
  it("shows the node name, platform, and status", () => {
    render(<NodeCard node={node} />);
    expect(screen.getByText("4090-box")).toBeInTheDocument();
    expect(screen.getByText(/linux/)).toBeInTheDocument();
    expect(screen.getByText("online")).toBeInTheDocument();
  });

  it("marks an offline node and says when it was last seen", () => {
    render(<NodeCard node={{ ...node, status: "offline", lastSeenUnixMs: BigInt(Date.now() - 300_000) }} />);
    expect(screen.getByText("offline")).toBeInTheDocument();
    expect(screen.getByText(/5m ago/)).toBeInTheDocument();
  });

  it("says so plainly when a node reports no devices", () => {
    render(<NodeCard node={node} />);
    expect(screen.getByText(/no devices reported/i)).toBeInTheDocument();
  });
});
