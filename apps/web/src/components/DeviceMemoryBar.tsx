import { MemoryPressure, type DeviceView } from "@modelhub/proto";
import { formatBytes } from "../format.js";

// Every byte figure here comes from computeBudget on the server; this
// component only turns them into widths and labels.
function percent(part: bigint, whole: bigint): string {
  if (whole === 0n) return "0%";
  return `${Math.round((Number(part) / Number(whole)) * 10_000) / 100}%`;
}

// Four distinct facts, kept visually distinct. Three saturated hues for the
// segments with real identity, a muted neutral for headroom (set aside, not
// competing for attention). Palette checked with the dataviz validator.
const SEGMENTS = [
  { key: "managedBytes", label: "Model Hub", className: "bg-[#2a78d6]" },
  { key: "foreignBytes", label: "Other processes", className: "bg-[#eb6834]" },
  { key: "headroomBytes", label: "Reserved headroom", className: "bg-[#c3c2b7]" },
  { key: "availableBytes", label: "Available", className: "bg-[#1baf7a]" },
] as const;

export function DeviceMemoryBar({ device }: { device: DeviceView }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium">{device.name}</span>
        <span className="text-slate-500">{device.localId}</span>
      </div>

      <div className="flex h-3 w-full overflow-hidden rounded bg-slate-200">
        {SEGMENTS.map(({ key, label, className }) => (
          <div
            key={key}
            data-testid={`segment-${key}`}
            data-bytes={String(device[key])}
            title={`${label}: ${formatBytes(device[key])}`}
            className={className}
            style={{ width: percent(device[key], device.totalBytes) }}
          />
        ))}
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-slate-600 sm:grid-cols-4">
        {SEGMENTS.map(({ key, label, className }) => (
          <div key={key} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${className}`} />
            <dt className="sr-only">{label}</dt>
            <dd>{label} · {formatBytes(device[key])}</dd>
          </div>
        ))}
      </dl>

      <p className="text-xs text-slate-600">
        {formatBytes(device.availableBytes)} available of {formatBytes(device.totalBytes)} total
      </p>

      {!device.schedulable && (
        <p className="text-xs text-amber-700">
          {device.pressure >= MemoryPressure.WARN
            ? "Not accepting work — the machine is under memory pressure"
            : "Not accepting work"}
        </p>
      )}
    </div>
  );
}
