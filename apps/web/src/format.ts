// Presentation only: no budget arithmetic happens in the browser.

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

export function formatBytes(bytes: bigint): string {
  let value = Number(bytes);
  if (value < 1024) return `${value} B`;

  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`;
}

export function formatRelativeTime(unixMs: bigint, now: number = Date.now()): string {
  if (unixMs === 0n) return "never";
  const seconds = Math.max(0, Math.round((now - Number(unixMs)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
