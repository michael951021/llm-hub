import { formatBytes } from "../format.js";

export interface DeviceViewLike {
  id: string;
  localId: string;
  kind: number;
  name: string;
  totalBytes: bigint;
  managedBytes: bigint;
  foreignBytes: bigint;
  headroomBytes: bigint;
  availableBytes: bigint;
  utilization: number;
  pressure: number;
  schedulable: boolean;
}

// Presentation only: a width percentage for a stacked meter is not a budget
// value, it is a layout detail derived from ones the server already computed.
// Every byte figure rendered by this component (managedBytes, foreignBytes,
// headroomBytes, availableBytes, totalBytes) comes straight from computeBudget
// on the server — this file never adds, subtracts, or clamps any of them.
function percent(part: bigint, whole: bigint): string {
  if (whole === 0n) return "0%";
  return `${(Number(part) / Number(whole)) * 100}%`;
}

// The four segments are deliberately distinct. "Memory Model Hub is using",
// "memory other processes are using", "reserved headroom", and "available"
// are four different facts, and a user who sees them separated understands
// their machine in a way a single bar never conveys.
//
// Colors: the dataviz skill's validator (scripts/validate_palette.js) was run
// against this exact segment order. The brief's original picks (sky/amber/
// slate-300/emerald) failed on two axes: slate-300 for "headroom" fell below
// both the lightness band and the chroma floor (reads as flat gray, not a
// color the eye can place in the set), and sky/amber/emerald as an ad hoc
// trio were never checked for CVD adjacency at all. The four hues below are
// the validated categorical palette's first four slots, used in their
// validated order (reordering to put a "greener" hue on "available" was
// tried and fails the normal-vision floor — see task-17-report.md) — blue,
// orange, aqua, yellow — which passes lightness band, chroma floor, CVD
// adjacency (>=8 target), and the normal-vision floor (>=15) in both light
// and dark renderings. Two of the four (aqua/yellow) sit under 3:1 contrast
// against a white surface, which the skill flags as needing visible labels
// rather than color-only identification — hence the labeled legend below the
// bar, not just the hover title.
const SEGMENTS = [
  { key: "managed", label: "Model Hub", className: "bg-[#2a78d6]" },
  { key: "foreign", label: "Other processes", className: "bg-[#eb6834]" },
  { key: "headroom", label: "Reserved headroom", className: "bg-[#1baf7a]" },
  { key: "available", label: "Available", className: "bg-[#eda100]" },
] as const;

export function DeviceMemoryBar({ device }: { device: DeviceViewLike }) {
  const values: Record<string, bigint> = {
    managed: device.managedBytes,
    foreign: device.foreignBytes,
    headroom: device.headroomBytes,
    available: device.availableBytes,
  };

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium">{device.name}</span>
        <span className="text-slate-500">{device.localId}</span>
      </div>

      <div className="flex h-3 w-full overflow-hidden rounded bg-slate-200">
        {SEGMENTS.map((segment) => (
          <div
            key={segment.key}
            data-testid={`segment-${segment.key}`}
            data-bytes={String(values[segment.key])}
            title={`${segment.label}: ${formatBytes(values[segment.key]!)}`}
            className={segment.className}
            style={{ width: percent(values[segment.key]!, device.totalBytes) }}
          />
        ))}
      </div>

      {/* Each segment labeled and individually inspectable, not just on hover. */}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-slate-600 sm:grid-cols-4">
        {SEGMENTS.map((segment) => (
          <div key={segment.key} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${segment.className}`} />
            <dt className="sr-only">{segment.label}</dt>
            <dd>{segment.label} · {formatBytes(values[segment.key]!)}</dd>
          </div>
        ))}
      </dl>

      <p className="text-xs text-slate-600">
        {formatBytes(device.availableBytes)} available of {formatBytes(device.totalBytes)} total
      </p>

      {!device.schedulable && (
        <p className="text-xs text-amber-700">
          {device.pressure >= 2
            ? "Not accepting work — the machine is under memory pressure"
            : "Not accepting work"}
        </p>
      )}
    </div>
  );
}
