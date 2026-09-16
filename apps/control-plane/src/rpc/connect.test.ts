import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport, Http2SessionManager } from "@connectrpc/connect-node";
import { eq } from "drizzle-orm";
import { ownerDb, organization, nodes, devices } from "@modelhub/db";
import { NodeService, DeviceKind, MemoryPressure } from "@modelhub/proto";
// NodeService.Connect lives on the agent-facing app: it's a bidi stream,
// which needs HTTP/2 framing that the browser-facing buildApp() no longer
// offers. See agent-app.ts.
import { buildAgentApp } from "../agent-app.js";
import { sweepOfflineNodes } from "../jobs/offline-sweeper.js";

let app: Awaited<ReturnType<typeof buildAgentApp>>;
let baseUrl: string;
let nodeId: string;
let privateKey: KeyObject;
// A single managed HTTP/2 session shared by every client() call in this
// file. connect-node's default behavior is to keep an HTTP/2 connection
// "idle" (not closed) after a stream ends, for reuse (idleConnectionTimeoutMs
// defaults to 15 minutes). Fastify's http2 server.close() waits for every
// open connection to end, so without explicitly aborting this session,
// app.close() in afterAll would hang past the test hook timeout.
let sessionManager: Http2SessionManager;
const orgId = `org_${randomUUID().slice(0, 8)}`;

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");

function authHeader(): string {
  const nonce = b64u(Buffer.from(randomUUID()));
  const payload = `${nodeId}.${Date.now()}.${nonce}`;
  return `ModelHubNode ${payload}.${b64u(sign(null, Buffer.from(payload), privateKey))}`;
}

beforeAll(async () => {
  const pair = generateKeyPairSync("ed25519");
  privateKey = pair.privateKey;
  const der = pair.publicKey.export({ format: "der", type: "spki" }) as Buffer;

  await ownerDb.insert(organization).values({ id: orgId, name: "Stream", slug: orgId, createdAt: new Date() });
  const [row] = await ownerDb.insert(nodes).values({
    orgId, name: "streamer", publicKey: new Uint8Array(der.subarray(der.length - 32)),
  }).returning({ id: nodes.id });
  nodeId = row!.id;

  app = await buildAgentApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  sessionManager = new Http2SessionManager(baseUrl);
});

afterAll(async () => {
  sessionManager.abort();
  await app.close();
});

function client() {
  return createClient(
    NodeService,
    createConnectTransport({ baseUrl, httpVersion: "2", sessionManager }),
  );
}

async function* agentMessages() {
  yield {
    payload: {
      case: "hello" as const,
      value: {
        agentVersion: "0.1.0",
        host: {
          hostname: "test-box", platform: "linux", arch: "amd64",
          osVersion: "6.8", agentVersion: "0.1.0",
          totalMemoryBytes: 68_719_476_736n, cpuCores: 16,
        },
      },
    },
  };
  yield {
    payload: {
      case: "inventory" as const,
      value: {
        devices: [{
          localId: "cuda:0", kind: DeviceKind.CUDA, index: 0,
          name: "NVIDIA GeForce RTX 4090", totalBytes: 25_769_803_776n,
          driverVersion: "560.35", computeCapability: "8.9", wiredLimitBytes: 0n,
        }],
      },
    },
  };
  yield {
    payload: {
      case: "samples" as const,
      value: {
        samples: [{
          localId: "cuda:0", usedBytes: 4_294_967_296n, managedBytes: 0n,
          utilization: 0.42, temperatureC: 61, powerWatts: 120,
          pressure: MemoryPressure.NORMAL, sampledAtUnixMs: BigInt(Date.now()),
        }],
      },
    },
  };
}

describe("NodeService.Connect", () => {
  it("rejects a stream with no node authorization", async () => {
    await expect(async () => {
      for await (const _ of client().connect(agentMessages())) break;
    }).rejects.toThrow();
  });

  it("acknowledges hello, stores inventory, and records samples", async () => {
    const stream = client().connect(agentMessages(), {
      headers: { authorization: authHeader() },
    });

    const first = await stream[Symbol.asyncIterator]().next();
    expect(first.value?.payload.case).toBe("helloAck");
    expect(first.value?.payload.value.nodeId).toBe(nodeId);

    // Let the remaining messages drain.
    await new Promise((r) => setTimeout(r, 300));

    const [device] = await ownerDb.select().from(devices).where(eq(devices.nodeId, nodeId));
    expect(device!.localId).toBe("cuda:0");
    expect(device!.kind).toBe("cuda");
    expect(device!.totalBytes).toBe(25_769_803_776n);
    expect(device!.lastUsedBytes).toBe(4_294_967_296n);
    expect(device!.lastUtilization).toBeCloseTo(0.42, 2);

    const [node] = await ownerDb.select().from(nodes).where(eq(nodes.id, nodeId));
    expect(node!.status).toBe("online");
    expect(node!.lastSeenAt).not.toBeNull();
  });

  it("removes devices the node stops reporting", async () => {
    await ownerDb.insert(devices).values({
      orgId, nodeId, localId: "cuda:9", kind: "cuda", name: "ghost", totalBytes: 1n,
    });
    const stream = client().connect(agentMessages(), {
      headers: { authorization: authHeader() },
    });
    for await (const _ of stream) break;
    await new Promise((r) => setTimeout(r, 300));

    const rows = await ownerDb.select().from(devices).where(eq(devices.nodeId, nodeId));
    expect(rows.map((r) => r.localId)).toEqual(["cuda:0"]);
  });

  it("refreshes lastSeenAt from an empty sample batch alone", async () => {
    // recordSamples deliberately does not early-return on an empty
    // `samples` array (a deviation from the task brief's sketch): an
    // agent that is connected and sends a SampleBatch with no devices in
    // it is still alive, so that alone should count as a heartbeat. Prove
    // it in isolation — no hello, no inventory in this stream — so this
    // doesn't pass merely because hello's markNodeOnline() also touches
    // lastSeenAt.
    await ownerDb.update(nodes)
      .set({ status: "offline", lastSeenAt: new Date(Date.now() - 60_000) })
      .where(eq(nodes.id, nodeId));

    async function* emptyBatchOnly() {
      yield { payload: { case: "samples" as const, value: { samples: [] } } };
    }

    const stream = client().connect(emptyBatchOnly(), {
      headers: { authorization: authHeader() },
    });
    for await (const _ of stream) break;
    await new Promise((r) => setTimeout(r, 300));

    const [node] = await ownerDb.select().from(nodes).where(eq(nodes.id, nodeId));
    expect(node!.status).toBe("online");
    expect(node!.lastSeenAt!.getTime()).toBeGreaterThan(Date.now() - 5_000);
  });

  it("marks a silent node degraded, then offline", async () => {
    await ownerDb.update(nodes)
      .set({ status: "online", lastSeenAt: new Date(Date.now() - 20_000) })
      .where(eq(nodes.id, nodeId));
    await sweepOfflineNodes();
    let [row] = await ownerDb.select().from(nodes).where(eq(nodes.id, nodeId));
    expect(row!.status).toBe("degraded");

    await ownerDb.update(nodes)
      .set({ lastSeenAt: new Date(Date.now() - 40_000) })
      .where(eq(nodes.id, nodeId));
    await sweepOfflineNodes();
    [row] = await ownerDb.select().from(nodes).where(eq(nodes.id, nodeId));
    expect(row!.status).toBe("offline");
  });
});
