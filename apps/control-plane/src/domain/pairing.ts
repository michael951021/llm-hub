import { createHmac, randomInt } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { ownerDb, pairingCodes, withOrg } from "@modelhub/db";
import { env } from "../env.js";

export class PairingCodeError extends Error {}

// No I, O, 0, or 1: they get misread when someone types a code off a screen.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateCode(): string {
  const pick = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `${pick()}-${pick()}`;
}

/** Case-insensitive, and tolerant of a missing or extra dash. */
export function normalize(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * HMAC keyed with PAIRING_CODE_PEPPER, which never touches the database: the
 * ~40-bit codespace is cheap to brute-force offline against a bare SHA-256.
 */
export function hashCode(code: string): string {
  return createHmac("sha256", env.PAIRING_CODE_PEPPER).update(normalize(code)).digest("hex");
}

export async function mintPairingCode(
  orgId: string, userId: string, nodeName: string,
): Promise<{ code: string; expiresAt: Date }> {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + env.PAIRING_CODE_TTL_MS);
  await withOrg(orgId, (tx) =>
    tx.insert(pairingCodes).values({ orgId, codeHash: hashCode(code), nodeName, createdBy: userId, expiresAt }),
  );
  return { code, expiresAt };
}

/**
 * Single-use and atomic: the claim is an UPDATE conditional on used_at being
 * null, so two agents racing one code produce exactly one winner. Runs on
 * ownerDb because the code itself is what establishes the org.
 */
export async function redeemPairingCode(code: string): Promise<{ orgId: string; nodeName: string }> {
  const hash = hashCode(code);
  const [row] = await ownerDb.update(pairingCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(pairingCodes.codeHash, hash), isNull(pairingCodes.usedAt)))
    .returning();

  if (!row) {
    const [existing] = await ownerDb.select({ id: pairingCodes.id }).from(pairingCodes)
      .where(eq(pairingCodes.codeHash, hash)).limit(1);
    throw new PairingCodeError(existing ? "pairing code already used" : "unknown pairing code");
  }

  if (row.expiresAt.getTime() < Date.now()) {
    // Release it so a retry sees "expired" again rather than "already used".
    await ownerDb.update(pairingCodes).set({ usedAt: null }).where(eq(pairingCodes.id, row.id));
    throw new PairingCodeError("pairing code expired");
  }

  return { orgId: row.orgId, nodeName: row.nodeName };
}
