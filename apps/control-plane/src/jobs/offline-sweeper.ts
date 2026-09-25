import { and, eq, lt, ne } from "drizzle-orm";
import { ownerDb, nodes } from "@modelhub/db";
import { env } from "../env.js";

// Three and six missed heartbeats. Derived from the interval the server hands
// agents, so changing SAMPLE_INTERVAL_MS can't make healthy nodes flap.
export const DEGRADED_AFTER_MS = env.SAMPLE_INTERVAL_MS * 3;
export const OFFLINE_AFTER_MS = env.SAMPLE_INTERVAL_MS * 6;

/**
 * Marks silent nodes degraded, then offline. Fleet-wide, so it runs on
 * ownerDb; it only ever touches the status column. The offline pass runs
 * first so a node past both thresholds lands on "offline" directly.
 */
export async function sweepOfflineNodes(now: Date = new Date()): Promise<number> {
  const offline = await ownerDb.update(nodes).set({ status: "offline" })
    .where(and(ne(nodes.status, "offline"), lt(nodes.lastSeenAt, new Date(now.getTime() - OFFLINE_AFTER_MS))))
    .returning({ id: nodes.id });
  const degraded = await ownerDb.update(nodes).set({ status: "degraded" })
    .where(and(eq(nodes.status, "online"), lt(nodes.lastSeenAt, new Date(now.getTime() - DEGRADED_AFTER_MS))))
    .returning({ id: nodes.id });
  return offline.length + degraded.length;
}

/** Runs the sweep on a timer. Returns a function that stops it. */
export function startOfflineSweeper(intervalMs = 5_000): () => void {
  const timer = setInterval(() => { void sweepOfflineNodes(); }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
