import { beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from "node:crypto";
import { Code } from "@connectrpc/connect";
import { createNode, createOrg, nodeAuthHeader } from "../test-helpers.js";
import { authenticateNode, NodeAuthError } from "./node-auth.js";

let orgId: string;
let nodeId: string;
let privateKey: KeyObject;

beforeAll(async () => {
  orgId = await createOrg();
  ({ nodeId, privateKey } = await createNode(orgId));
});

describe("node authentication", () => {
  it("accepts a correctly signed header", async () => {
    expect(await authenticateNode(nodeAuthHeader(nodeId, privateKey))).toEqual({ nodeId, orgId });
  });

  it("fails as Unauthenticated", async () => {
    const err = await authenticateNode(null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeAuthError);
    expect((err as NodeAuthError).code).toBe(Code.Unauthenticated);
  });

  it.each([
    ["missing", null],
    ["wrong scheme", "Bearer abc"],
    ["one-part", "ModelHubNode garbage"],
    ["non-uuid node id", "ModelHubNode not-a-uuid.1.abc.def"],
  ])("rejects a %s header", async (_label, header) => {
    await expect(authenticateNode(header)).rejects.toThrow(NodeAuthError);
  });

  it("rejects a signature made with the wrong key", async () => {
    const { privateKey: other } = generateKeyPairSync("ed25519");
    await expect(authenticateNode(nodeAuthHeader(nodeId, other))).rejects.toThrow(/signature/);
  });

  it.each([["stale", -10], ["future-dated", 10]])("rejects a %s timestamp", async (_label, minutes) => {
    const at = Date.now() + minutes * 60_000;
    await expect(authenticateNode(nodeAuthHeader(nodeId, privateKey, at))).rejects.toThrow(/timestamp/);
  });

  it("rejects a replayed nonce", async () => {
    const header = nodeAuthHeader(nodeId, privateKey);
    await authenticateNode(header);
    await expect(authenticateNode(header)).rejects.toThrow(/replay/);
  });

  it("rejects an unknown node id", async () => {
    await expect(authenticateNode(nodeAuthHeader(randomUUID(), privateKey))).rejects.toThrow(/unknown node/);
  });

  it("fails cleanly when the stored public key is corrupted", async () => {
    const corrupt = await createNode(orgId, { publicKey: randomBytes(16) });
    await expect(authenticateNode(nodeAuthHeader(corrupt.nodeId, privateKey)))
      .rejects.toThrow(/stored node key is invalid/);
  });
});
