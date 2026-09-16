import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, ownerDb, withOrg } from "./client.js";
import { nodes, organization } from "./schema/index.js";

const orgA = `org_${randomUUID().slice(0, 8)}`;
const orgB = `org_${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  await ownerDb.insert(organization).values([
    { id: orgA, name: "Org A", slug: orgA },
    { id: orgB, name: "Org B", slug: orgB },
  ]);
  await ownerDb.insert(nodes).values([
    { orgId: orgA, name: "a-node", publicKey: new Uint8Array(32).fill(1) },
    { orgId: orgB, name: "b-node", publicKey: new Uint8Array(32).fill(2) },
  ]);
});

afterAll(async () => {
  await ownerDb.delete(organization).where(sql`id in (${orgA}, ${orgB})`);
});

describe("row-level security", () => {
  it("shows an org only its own nodes", async () => {
    const rows = await withOrg(orgA, (tx) => tx.select().from(nodes));
    expect(rows.map((r) => r.name)).toEqual(["a-node"]);
  });

  it("hides other orgs' nodes even from an explicit query", async () => {
    const rows = await withOrg(orgB, (tx) =>
      tx.select().from(nodes).where(sql`${nodes.orgId} = ${orgA}`),
    );
    expect(rows).toEqual([]);
  });

  it("refuses to write a row belonging to another org", async () => {
    await expect(
      withOrg(orgA, (tx) =>
        tx.insert(nodes).values({
          orgId: orgB,
          name: "smuggled",
          publicKey: new Uint8Array(32).fill(3),
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("returns nothing when no org is set", async () => {
    const rows = await db.select().from(nodes);
    expect(rows).toEqual([]);
  });
});

describe("bytea round trip", () => {
  it("preserves an Ed25519-sized public key exactly, byte for byte", async () => {
    // A real-looking 32-byte key, not all-zero/all-same, so a byte-order or
    // truncation bug would actually show up as a mismatch.
    const key = new Uint8Array(32);
    for (let i = 0; i < key.length; i++) key[i] = (i * 7 + 3) % 256;

    const [inserted] = await withOrg(orgA, (tx) =>
      tx.insert(nodes).values({ orgId: orgA, name: "key-node", publicKey: key }).returning(),
    );

    expect(inserted!.publicKey).toBeInstanceOf(Uint8Array);
    expect(Array.from(inserted!.publicKey)).toEqual(Array.from(key));

    const [reread] = await withOrg(orgA, (tx) =>
      tx.select().from(nodes).where(sql`${nodes.id} = ${inserted!.id}`),
    );
    expect(Array.from(reread!.publicKey)).toEqual(Array.from(key));
  });
});
