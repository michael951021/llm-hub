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
  // Round to two decimal places — a raw float (33.33333333333333%) is noise
  // in the DOM and buys nothing visually at 3px-wide segments.
  const pct = Math.round((Number(part) / Number(whole)) * 100 * 100) / 100;
  return `${pct}%`;
}

// The four segments are deliberately distinct. "Memory Model Hub is using",
// "memory other processes are using", "reserved headroom", and "available"
// are four different facts, and a user who sees them separated understands
// their machine in a way a single bar never conveys.
//
// Colors: run through the dataviz skill's validator (scripts/validate_palette.js).
// v1 of this bar assigned the validated palette's first four slots in order
// (blue/orange/aqua/yellow -> managed/foreign/headroom/available), which
// cleared every check but put green on "headroom" (unusable memory) and
// yellow on "available" (the one number this screen exists to answer) —
// review correctly called that an inverted at-a-glance read on a screen a
// user mostly glances at rather than studies. Fixed by dropping to three
// saturated hues for the three segments with real identity (managed,
// foreign, available) plus a muted neutral for headroom, which is
// semantically the least interesting of the four ("set aside", not
// competing for attention) — and, as review predicted, removing headroom's
// hue from the categorical set gives the remaining three much more
// separation than the four-hue version had. "Available" is now the aqua/
// green slot. See task-17-report.md for the full validator output.
const SEGMENTS = [
  { key: "managed", label: "Model Hub", className: "bg-[#2a78d6]" },
  { key: "foreign", label: "Other processes", className: "bg-[#eb6834]" },
  // Muted neutral, not a categorical identity hue — deliberately
  // non-competing. Same "Baseline / axis" role the palette reference uses
  // for recessive chrome (gridlines, axes), not a series color.
  { key: "headroom", label: "Reserved headroom", className: "bg-[#c3c2b7]" },
  { key: "available", label: "Available", className: "bg-[#1baf7a]" },
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
