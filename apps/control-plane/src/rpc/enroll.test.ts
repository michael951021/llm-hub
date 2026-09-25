import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { nodes, ownerDb } from "@modelhub/db";
import { enrollNode, EnrollmentError } from "../domain/nodes.js";
import { hostColumns } from "../domain/wire.js";
import { mintPairingCode } from "../domain/pairing.js";
import { buildAgentApp } from "../server.js";
import { createOrg, newNodeKey } from "../test-helpers.js";

let app: Awaited<ReturnType<typeof buildAgentApp>>;
let orgId: string;

beforeAll(async () => {
  orgId = await createOrg("Fleet");
  app = await buildAgentApp();
});
afterAll(async () => { await app.close(); });

const newCode = async () => (await mintPairingCode(orgId, "user_1", "")).code;

function enroll(pairingCode: string, publicKey: Uint8Array, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: "/modelhub.v1.NodeService/Enroll",
    headers: { "content-type": "application/json" },
    payload: {
      pairingCode,
      publicKey: Buffer.from(publicKey).toString("base64"),
      nodeName: "node",
      host: { hostname: "h", platform: "linux", arch: "amd64" },
      ...extra,
    },
  });
}

describe("NodeService.Enroll", () => {
  it("creates a node bound to the code's organization", async () => {
    const { publicKey } = newNodeKey();
    const res = await enroll(await newCode(), publicKey, {
      nodeName: "mac-studio",
      host: {
        hostname: "mac-studio.local", platform: "darwin", arch: "arm64",
        osVersion: "15.0", agentVersion: "0.1.0", totalMemoryBytes: "137438953472", cpuCores: 24,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ orgId, orgName: "Fleet" });
    const [row] = await ownerDb.select().from(nodes).where(eq(nodes.id, res.json().nodeId));
    expect(row).toMatchObject({ orgId, name: "mac-studio", platform: "darwin", cpuCores: 24 });
    expect(Buffer.from(row!.publicKey)).toEqual(Buffer.from(publicKey));
  });

  it("rejects an invalid pairing code as invalid_argument", async () => {
    const res = await enroll("ZZZZ-ZZZZ", newNodeKey().publicKey);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_argument", message: "unknown pairing code" });
  });

  it("rejects a public key that is not 32 bytes", async () => {
    const res = await enroll(await newCode(), new Uint8Array(16));
    expect(res.statusCode).toBe(400);
  });

  it("rejects an already-enrolled key without burning the pairing code", async () => {
    const { publicKey } = newNodeKey();
    expect((await enroll(await newCode(), publicKey)).statusCode).toBe(200);

    const code = await newCode();
    const duplicate = await enroll(code, publicKey);
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json().message).toMatch(/already enrolled/);
    expect((await enroll(code, newNodeKey().publicKey)).statusCode).toBe(200);
  });

  it("maps a concurrent duplicate-key race to EnrollmentError for the loser", async () => {
    // Both can pass the app-level check before either insert commits; the
    // unique index has to catch the loser.
    const { publicKey } = newNodeKey();
    const host = hostColumns(undefined);
    const results = await Promise.allSettled([
      enrollNode({ pairingCode: await newCode(), publicKey, nodeName: "race-1", host }),
      enrollNode({ pairingCode: await newCode(), publicKey, nodeName: "race-2", host }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(loser?.reason).toBeInstanceOf(EnrollmentError);
  });
});
