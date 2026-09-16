import { beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { ownerDb, organization, pairingCodes } from "@modelhub/db";
import { eq } from "drizzle-orm";
import { mintPairingCode, redeemPairingCode, PairingCodeError, hashCode, normalize } from "./pairing.js";

const orgId = `org_${randomUUID().slice(0, 8)}`;
const userId = `user_${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  // Task 6 replaced organization's schema with the one Better Auth generates;
  // createdAt has no DB-side default there, so a direct insert must supply it
  // (see packages/db/src/rls.test.ts for the same note).
  await ownerDb.insert(organization).values({ id: orgId, name: "T", slug: orgId, createdAt: new Date() });
});

describe("pairing codes", () => {
  it("mints a human-typeable code", async () => {
    const { code, expiresAt } = await mintPairingCode(orgId, userId, "mac-studio");
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("never stores the code itself", async () => {
    const { code } = await mintPairingCode(orgId, userId, "n1");
    const rows = await ownerDb.select().from(pairingCodes).where(eq(pairingCodes.orgId, orgId));
    for (const row of rows) expect(row.codeHash).not.toContain(code);
  });

  it("redeems a valid code once and returns its org", async () => {
    const { code } = await mintPairingCode(orgId, userId, "four-ninety");
    const result = await redeemPairingCode(code);
    expect(result.orgId).toBe(orgId);
    expect(result.nodeName).toBe("four-ninety");
  });

  it("refuses a second redemption of the same code", async () => {
    const { code } = await mintPairingCode(orgId, userId, "n2");
    await redeemPairingCode(code);
    await expect(redeemPairingCode(code)).rejects.toThrow(PairingCodeError);
  });

  it("refuses an unknown code", async () => {
    await expect(redeemPairingCode("ZZZZ-ZZZZ")).rejects.toThrow(PairingCodeError);
  });

  it("refuses an expired code", async () => {
    const { code } = await mintPairingCode(orgId, userId, "n3");
    const hash = (await import("./pairing.js")).hashCode(code);
    await ownerDb.update(pairingCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(pairingCodes.codeHash, hash));
    await expect(redeemPairingCode(code)).rejects.toThrow(/expired/i);
  });

  it("is case-insensitive and tolerates a missing dash", async () => {
    const { code } = await mintPairingCode(orgId, userId, "n4");
    const mangled = code.toLowerCase().replace("-", "");
    const result = await redeemPairingCode(mangled);
    expect(result.orgId).toBe(orgId);
  });

  it("hashes with a keyed pepper, not a bare SHA-256", async () => {
    const { code } = await mintPairingCode(orgId, userId, "n5");
    const plainSha256 = createHash("sha256").update(normalize(code)).digest("hex");
    expect(hashCode(code)).not.toBe(plainSha256);
  });
});
