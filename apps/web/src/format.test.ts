import { describe, expect, it } from "vitest";
import { formatBytes, formatRelativeTime } from "./format.js";

describe("formatBytes", () => {
  it("uses binary units with one decimal place", () => {
    expect(formatBytes(0n)).toBe("0 B");
    expect(formatBytes(1024n)).toBe("1.0 KiB");
    expect(formatBytes(BigInt(24 * 1024 ** 3))).toBe("24.0 GiB");
    expect(formatBytes(BigInt(1.5 * 1024 ** 3))).toBe("1.5 GiB");
  });
});

describe("formatRelativeTime", () => {
  it("describes recent timestamps in seconds", () => {
    const now = Date.now();
    expect(formatRelativeTime(BigInt(now - 3_000), now)).toBe("3s ago");
  });

  it("describes older timestamps in minutes", () => {
    const now = Date.now();
    expect(formatRelativeTime(BigInt(now - 120_000), now)).toBe("2m ago");
  });

  it("handles a node that has never reported", () => {
    expect(formatRelativeTime(0n, Date.now())).toBe("never");
  });
});
