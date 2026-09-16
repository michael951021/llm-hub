import { createHash, randomInt } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { ownerDb, pairingCodes, withOrg } from "@modelhub/db";
import { env } from "../env.js";

export class PairingCodeError extends Error {
  statusCode = 400;
  code = "invalid_pairing_code";
}

// No I, O, 0, or 1: these get misread when someone types a code off a screen.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateCode(): string {
  const pick = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `${pick()}-${pick()}`;
}

/** Codes are short-lived and single-use, so a plain SHA-256 is the right tool. */
export function hashCode(code: string): string {
  return createHash("sha256").update(normalize(code)).digest("hex");
}

export function normalize(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export async function mintPairingCode(
  orgId: string, userId: string, nodeName: string,
): Promise<{ code: string; expiresAt: Date }> {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + env.PAIRING_CODE_TTL_MS);

  await withOrg(orgId, (tx) =>
    tx.insert(pairingCodes).values({
      orgId, codeHash: hashCode(code), nodeName, createdBy: userId, expiresAt,
    }),
  );

  return { code, expiresAt };
}

/**
 * Redeemed by an unauthenticated agent, so this runs on the owner connection —
 * there is no org context yet; the code IS the credential that establishes one.
 * The update is conditional on used_at being null, which makes redemption
 * atomic: two agents racing the same code produce exactly one winner.
 */
export async function redeemPairingCode(
  code: string,
): Promise<{ orgId: string; nodeName: string; pairingCodeId: string }> {
  const hash = hashCode(code);

  const claimed = await ownerDb
    .update(pairingCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(pairingCodes.codeHash, hash), isNull(pairingCodes.usedAt)))
    .returning();

  if (claimed.length === 0) {
    const existing = await ownerDb.select().from(pairingCodes)
      .where(eq(pairingCodes.codeHash, hash)).limit(1);
    throw new PairingCodeError(
      existing.length > 0 ? "pairing code already used" : "unknown pairing code",
    );
  }

  const row = claimed[0]!;
  if (row.expiresAt.getTime() < Date.now()) {
    // Release it so the expiry message is stable if the agent retries.
    await ownerDb.update(pairingCodes).set({ usedAt: null })
      .where(eq(pairingCodes.id, row.id));
    throw new PairingCodeError("pairing code expired");
  }

  return { orgId: row.orgId, nodeName: row.nodeName, pairingCodeId: row.id };
}
