import { beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { ownerDb, pairingCodes } from "@modelhub/db";
import { createOrg } from "../test-helpers.js";
import { hashCode, mintPairingCode, normalize, PairingCodeError, redeemPairingCode } from "./pairing.js";

let orgId: string;
const mint = (name = "n") => mintPairingCode(orgId, "user_1", name);

beforeAll(async () => { orgId = await createOrg(); });

describe("pairing codes", () => {
  it("mints a human-typeable code that expires in the future", async () => {
    const { code, expiresAt } = await mint();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("stores a peppered HMAC, not the code or its bare SHA-256", async () => {
    const { code } = await mint();
    const [row] = await ownerDb.select().from(pairingCodes).where(eq(pairingCodes.codeHash, hashCode(code)));
    expect(row).toBeDefined();
    expect(row!.codeHash).not.toBe(createHash("sha256").update(normalize(code)).digest("hex"));
  });

  it("redeems once, returning the org and the name it was minted with", async () => {
    const { code } = await mint("four-ninety");
    expect(await redeemPairingCode(code)).toEqual({ orgId, nodeName: "four-ninety" });
    await expect(redeemPairingCode(code)).rejects.toThrow(/already used/);
  });

  it("has exactly one winner when two redemptions race", async () => {
    const { code } = await mint();
    const results = await Promise.allSettled([redeemPairingCode(code), redeemPairingCode(code)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("refuses an unknown code", async () => {
    await expect(redeemPairingCode("ZZZZ-ZZZZ")).rejects.toThrow(PairingCodeError);
  });

  it("refuses an expired code, and keeps saying so on retry", async () => {
    const { code } = await mint();
    await ownerDb.update(pairingCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(pairingCodes.codeHash, hashCode(code)));
    await expect(redeemPairingCode(code)).rejects.toThrow(/expired/);
    await expect(redeemPairingCode(code)).rejects.toThrow(/expired/);
  });

  it("is case-insensitive and tolerates a missing dash", async () => {
    const { code } = await mint();
    expect((await redeemPairingCode(code.toLowerCase().replace("-", ""))).orgId).toBe(orgId);
  });
});
