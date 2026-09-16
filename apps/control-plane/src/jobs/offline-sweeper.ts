import { and, eq, lt, ne } from "drizzle-orm";
import { ownerDb, nodes } from "@modelhub/db";

/** Three missed heartbeats. */
export const DEGRADED_AFTER_MS = 15_000;
/** Six missed heartbeats. */
export const OFFLINE_AFTER_MS = 30_000;

/**
 * Marks nodes degraded after 15s of silence and offline after 30s.
 *
 * Runs on the owner connection: this is a fleet-wide job with no single
 * org context, and it only ever changes a status column — there is no
 * tenant data to leak through it, so it does not need withOrg().
 *
 * Order matters: the offline pass runs first so that a node silent for
 * 40s (past both thresholds) lands on "offline" and is not first flipped
 * to "degraded" by the second pass, which only touches nodes still
 * "online" going in.
 */
export async function sweepOfflineNodes(now: Date = new Date()): Promise<number> {
  const offlineCutoff = new Date(now.getTime() - OFFLINE_AFTER_MS);
  const degradedCutoff = new Date(now.getTime() - DEGRADED_AFTER_MS);

  const offline = await ownerDb.update(nodes)
    .set({ status: "offline" })
    .where(and(
      ne(nodes.status, "offline"),
      lt(nodes.lastSeenAt, offlineCutoff),
    )).returning({ id: nodes.id });

  const degraded = await ownerDb.update(nodes)
    .set({ status: "degraded" })
    .where(and(
      eq(nodes.status, "online"),
      lt(nodes.lastSeenAt, degradedCutoff),
    )).returning({ id: nodes.id });

  return offline.length + degraded.length;
}

/**
 * Starts the periodic sweep. Returns a function that stops it.
 *
 * `buildApp` deliberately does not call this — tests need to drive
 * `sweepOfflineNodes` manually on their own clock, and Task 18's
 * end-to-end test depends on that. Only `main.ts` starts it, for the
 * real running process.
 */
export function startOfflineSweeper(intervalMs = 5_000): () => void {
  const timer = setInterval(() => { void sweepOfflineNodes(); }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
