import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { create } from "@bufbuild/protobuf";
import { NodeViewSchema, type NodeView } from "@modelhub/proto";
import { NodeCard } from "./NodeCard.js";

const node = (overrides: Partial<NodeView> = {}): NodeView => ({
  ...create(NodeViewSchema, {
    id: "n1", name: "4090-box", status: "online", lastSeenUnixMs: BigInt(Date.now() - 2_000),
    host: { platform: "linux", arch: "amd64", agentVersion: "0.1.0", cpuCores: 16 },
  }),
  ...overrides,
});

describe("NodeCard", () => {
  it("shows the node name, platform, and status", () => {
    render(<NodeCard node={node()} />);
    expect(screen.getByText("4090-box")).toBeInTheDocument();
    expect(screen.getByText("linux/amd64 · 16 cores · agent 0.1.0")).toBeInTheDocument();
    expect(screen.getByText("online")).toBeInTheDocument();
  });

  it("marks an offline node and says when it was last seen", () => {
    render(<NodeCard node={node({ status: "offline", lastSeenUnixMs: BigInt(Date.now() - 300_000) })} />);
    expect(screen.getByText("offline")).toBeInTheDocument();
    expect(screen.getByText("seen 5m ago")).toBeInTheDocument();
  });

  it("renders a node that has not reported host facts or devices yet", () => {
    render(<NodeCard node={node({ host: undefined })} />);
    expect(screen.getByText(/host details not reported yet/i)).toBeInTheDocument();
    expect(screen.getByText(/no devices reported/i)).toBeInTheDocument();
  });
});
