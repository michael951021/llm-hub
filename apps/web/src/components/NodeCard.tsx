import { DeviceMemoryBar, type DeviceViewLike } from "./DeviceMemoryBar.js";
import { formatRelativeTime } from "../format.js";

export interface HostInfoLike {
  hostname: string;
  platform: string;
  arch: string;
  osVersion: string;
  agentVersion: string;
  totalMemoryBytes: bigint;
  cpuCores: number;
}

export interface NodeViewLike {
  id: string;
  name: string;
  status: string;
  lastSeenUnixMs: bigint;
  // Optional to match the generated NodeView (a proto3 message field), even
  // though a healthy node always reports one — a node that has enrolled but
  // not yet completed its first heartbeat should render, not crash.
  host?: HostInfoLike | undefined;
  devices: DeviceViewLike[];
}

const STATUS_STYLES: Record<string, string> = {
  online: "bg-emerald-100 text-emerald-800",
  degraded: "bg-amber-100 text-amber-800",
  offline: "bg-slate-200 text-slate-600",
};

export function NodeCard({ node }: { node: NodeViewLike }) {
  return (
    <section className="rounded-lg border bg-white p-4 shadow-sm">
      <header className="mb-3 flex items-start justify-between">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold">{node.name}</h2>
          <p className="text-xs text-slate-500">
            {node.host
              ? `${node.host.platform}/${node.host.arch} · ${node.host.cpuCores} cores · agent ${node.host.agentVersion || "—"}`
              : "Host details not reported yet"}
          </p>
        </div>
        <div className="text-right">
          <span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLES[node.status] ?? STATUS_STYLES.offline}`}>
            {node.status}
          </span>
          <p className="mt-1 text-xs text-slate-500">
            seen {formatRelativeTime(node.lastSeenUnixMs)}
          </p>
        </div>
      </header>

      {node.devices.length === 0 ? (
        <p className="text-sm text-slate-500">No devices reported yet.</p>
      ) : (
        <div className="space-y-3">
          {node.devices.map((device) => (
            <DeviceMemoryBar key={device.id} device={device} />
          ))}
        </div>
      )}
    </section>
  );
}
