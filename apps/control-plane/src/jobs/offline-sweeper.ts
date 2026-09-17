import { and, eq, lt, ne } from "drizzle-orm";
import { ownerDb, nodes } from "@modelhub/db";
import { env } from "../env.js";

/**
 * Three missed heartbeats. Derived from the sample interval rather than
 * hardcoded, because SAMPLE_INTERVAL_MS is configurable and the server hands
 * the agent whatever it is set to: fixed 15s/30s cutoffs are only "three and
 * six heartbeats" at the 5s default. At 10s every healthy node would
 * oscillate online -> degraded -> online, and at 30s the entire fleet would
 * read offline while streaming perfectly.
 */
export const DEGRADED_AFTER_MS = env.SAMPLE_INTERVAL_MS * 3;
/** Six missed heartbeats. Same derivation as DEGRADED_AFTER_MS above. */
export const OFFLINE_AFTER_MS = env.SAMPLE_INTERVAL_MS * 6;

/**
 * Marks nodes degraded after three missed heartbeats and offline after six
 * (15s and 30s at the default 5s sample interval).
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
