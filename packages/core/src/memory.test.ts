import { describe, expect, it } from "vitest";
import { computeBudget, HEADROOM_MIN_BYTES } from "./memory.js";

const GiB = 1024 ** 3;

describe("computeBudget — cuda", () => {
  it("subtracts foreign memory, our own memory, and headroom", () => {
    const b = computeBudget({
      kind: "cuda",
      totalBytes: 24 * GiB,
      usedBytes: 10 * GiB,     // 6 ours + 4 someone else's
      managedBytes: 6 * GiB,
    });

    expect(b.foreignBytes).toBe(4 * GiB);
    expect(b.headroomBytes).toBe(Math.floor(24 * GiB * 0.08));
    expect(b.availableBytes).toBe(24 * GiB - 4 * GiB - 6 * GiB - b.headroomBytes);
    expect(b.schedulable).toBe(true);
  });

  it("applies the headroom floor on small devices", () => {
    const b = computeBudget({
      kind: "cuda", totalBytes: 4 * GiB, usedBytes: 0, managedBytes: 0,
    });
    expect(b.headroomBytes).toBe(HEADROOM_MIN_BYTES);
  });

  it("never reports negative availability when foreign memory floods the device", () => {
    const b = computeBudget({
      kind: "cuda", totalBytes: 24 * GiB, usedBytes: 24 * GiB, managedBytes: 0,
    });
    expect(b.foreignBytes).toBe(24 * GiB);
    expect(b.availableBytes).toBe(0);
  });

  it("clamps foreign to zero when our accounting briefly exceeds the driver's", () => {
    // Can happen between a load completing and the next NVML sample.
    const b = computeBudget({
      kind: "cuda", totalBytes: 24 * GiB, usedBytes: 2 * GiB, managedBytes: 3 * GiB,
    });
    expect(b.foreignBytes).toBe(0);
  });
});

describe("computeBudget — metal unified memory", () => {
  it("honors the wired limit and the OS reserve, whichever binds first", () => {
    const b = computeBudget({
      kind: "metal",
      totalBytes: 128 * GiB,
      usedBytes: 20 * GiB,
      managedBytes: 16 * GiB,
      wiredLimitBytes: 96 * GiB,
      pressure: "normal",
    });

    // OS reserve is max(8 GiB, 15% of 128 GiB) = 19.2 GiB, so the ceiling is
    // min(96 GiB, 128 - 19.2 GiB) = 96 GiB — the wired limit binds.
    expect(b.foreignBytes).toBe(4 * GiB);
    expect(b.availableBytes).toBe(96 * GiB - 16 * GiB - 4 * GiB);
  });

  it("falls back to 75% of physical memory when no wired limit is reported", () => {
    const b = computeBudget({
      kind: "metal", totalBytes: 32 * GiB, usedBytes: 0, managedBytes: 0,
      pressure: "normal",
    });
    // ceiling = min(0.75 × 32 GiB = 24 GiB, 32 GiB − max(8 GiB, 4.8 GiB) = 24 GiB)
    expect(b.availableBytes).toBe(24 * GiB);
  });

  it("reserves far more on a machine flagged interactive", () => {
    const shared = {
      kind: "metal" as const, totalBytes: 36 * GiB, usedBytes: 0,
      managedBytes: 0, pressure: "normal" as const,
    };
    const normal = computeBudget(shared);
    const daily = computeBudget({ ...shared, interactive: true });
    expect(daily.availableBytes).toBeLessThan(normal.availableBytes);
  });

  it("is unschedulable under memory pressure warn", () => {
    const b = computeBudget({
      kind: "metal", totalBytes: 64 * GiB, usedBytes: 0, managedBytes: 0,
      pressure: "warn",
    });
    expect(b.schedulable).toBe(false);
    expect(b.availableBytes).toBe(0);
  });

  it("is unschedulable under memory pressure critical", () => {
    const b = computeBudget({
      kind: "metal", totalBytes: 64 * GiB, usedBytes: 0, managedBytes: 0,
      pressure: "critical",
    });
    expect(b.schedulable).toBe(false);
  });
});

describe("computeBudget — cpu", () => {
  it("reserves system memory for the operating system", () => {
    const b = computeBudget({
      kind: "cpu", totalBytes: 64 * GiB, usedBytes: 8 * GiB, managedBytes: 0,
    });
    const reserve = Math.max(8 * GiB, Math.floor(64 * GiB * 0.15));
    expect(b.availableBytes).toBe(64 * GiB - 8 * GiB - reserve);
  });
});

describe("computeBudget — invariants", () => {
  const cases = [
    { kind: "cuda" as const, totalBytes: 24 * GiB },
    { kind: "metal" as const, totalBytes: 96 * GiB },
    { kind: "cpu" as const, totalBytes: 128 * GiB },
  ];

  it("never returns availability above total, or below zero", () => {
    for (const c of cases) {
      for (const used of [0, 1, 7, 23, 95, 128]) {
        const b = computeBudget({
          ...c, usedBytes: Math.min(used * GiB, c.totalBytes), managedBytes: 0,
        });
        expect(b.availableBytes).toBeGreaterThanOrEqual(0);
        expect(b.availableBytes).toBeLessThanOrEqual(c.totalBytes);
      }
    }
  });

  it("returns a zero budget for a device reporting no memory at all", () => {
    const b = computeBudget({
      kind: "cuda", totalBytes: 0, usedBytes: 0, managedBytes: 0,
    });
    expect(b.availableBytes).toBe(0);
    expect(b.schedulable).toBe(false);
  });
});
