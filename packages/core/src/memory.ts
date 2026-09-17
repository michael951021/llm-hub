export type DeviceKind = "cpu" | "cuda" | "metal";
export type MemoryPressure = "normal" | "warn" | "critical";

export interface MemoryInput {
  kind: DeviceKind;
  /** Physical memory on the device; system RAM for cpu and metal. */
  totalBytes: number;
  /** Everything currently in use on the device — ours plus everyone else's. */
  usedBytes: number;
  /** What our own replicas hold. Zero until slice 2 loads anything. */
  managedBytes: number;
  /** macOS only: iogpu.wired_limit_mb, when the system reports one. */
  wiredLimitBytes?: number;
  /** macOS only. Absent is treated as "normal". */
  pressure?: MemoryPressure;
  /** Someone's daily-driver machine: reserve much more for them. */
  interactive?: boolean;
}

export interface MemoryBudget {
  totalBytes: number;
  managedBytes: number;
  /** Memory held by processes that are not ours. The critical term. */
  foreignBytes: number;
  headroomBytes: number;
  availableBytes: number;
  schedulable: boolean;
}

/** Fragmentation and driver context overhead, as a fraction of device memory. */
export const HEADROOM_FRAC = 0.08;
export const HEADROOM_MIN_BYTES = 512 * 1024 ** 2;

/** Memory left to the operating system on shared-memory devices. */
export const OS_RESERVE_FRAC = 0.15;
export const OS_RESERVE_MIN_BYTES = 8 * 1024 ** 3;

/** Reserve on a machine someone actually uses. */
export const INTERACTIVE_RESERVE_FRAC = 0.30;

/** Apple's practical ceiling when the system reports no explicit wired limit. */
export const METAL_DEFAULT_CEILING_FRAC = 0.75;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export function computeBudget(input: MemoryInput): MemoryBudget {
  const { kind, totalBytes, usedBytes, managedBytes } = input;
  const pressure = input.pressure ?? "normal";

  // Our own accounting can briefly exceed the driver's view — for instance
  // between a load finishing and the next sample. Clamp rather than go negative.
  const foreignBytes = clamp(usedBytes - managedBytes, 0, totalBytes);

  if (totalBytes <= 0) {
    return {
      totalBytes: 0, managedBytes: 0, foreignBytes: 0,
      headroomBytes: 0, availableBytes: 0, schedulable: false,
    };
  }

  // Memory pressure is a scheduling signal, not just telemetry: at warn we
  // stop placing here, and at critical the agent is already evicting.
  const schedulable = pressure === "normal";

  let headroomBytes: number;
  let ceiling: number;

  switch (kind) {
    case "cuda": {
      headroomBytes = Math.max(HEADROOM_MIN_BYTES, Math.floor(totalBytes * HEADROOM_FRAC));
      ceiling = totalBytes;
      break;
    }
    case "metal": {
      const reserveFrac = input.interactive ? INTERACTIVE_RESERVE_FRAC : OS_RESERVE_FRAC;
      const osReserve = Math.max(OS_RESERVE_MIN_BYTES, Math.floor(totalBytes * reserveFrac));
      const wiredLimit = input.wiredLimitBytes && input.wiredLimitBytes > 0
        ? input.wiredLimitBytes
        : Math.floor(totalBytes * METAL_DEFAULT_CEILING_FRAC);
      headroomBytes = 0; // The OS reserve already plays this role here.
      ceiling = Math.min(wiredLimit, totalBytes - osReserve);
      break;
    }
    case "cpu": {
      const reserveFrac = input.interactive ? INTERACTIVE_RESERVE_FRAC : OS_RESERVE_FRAC;
      headroomBytes = Math.max(OS_RESERVE_MIN_BYTES, Math.floor(totalBytes * reserveFrac));
      ceiling = totalBytes;
      break;
    }
    // A kind outside the union used to fall through with headroomBytes and
    // ceiling unassigned, making availableBytes NaN — and BigInt(NaN) throws,
    // so one poisoned device row took ListNodes down with a 500 for the
    // entire org rather than for that one device. Fail at the source instead.
    default:
      throw new Error(`unknown device kind: ${String(kind)}`);
  }

  const raw = ceiling - foreignBytes - managedBytes - headroomBytes;
  const availableBytes = schedulable ? clamp(raw, 0, totalBytes) : 0;

  return { totalBytes, managedBytes, foreignBytes, headroomBytes, availableBytes, schedulable };
}
