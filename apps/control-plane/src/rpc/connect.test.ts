import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KeyObject } from "node:crypto";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { setTimeout as sleep } from "node:timers/promises";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport, Http2SessionManager } from "@connectrpc/connect-node";
import { eq } from "drizzle-orm";
import { devices, nodes, ownerDb } from "@modelhub/db";
import { DeviceKind, MemoryPressure, NodeService, type AgentMessageSchema } from "@modelhub/proto";
import { sweepOfflineNodes } from "../jobs/offline-sweeper.js";
import { buildAgentApp } from "../server.js";
import { createNode, createOrg, listen, nodeAuthHeader } from "../test-helpers.js";

let app: Awaited<ReturnType<typeof buildAgentApp>>;
// One shared HTTP/2 session, aborted in afterAll: connect-node keeps idle
// sessions open for reuse, and Fastify's close() waits on open connections.
let sessionManager: Http2SessionManager;
let baseUrl: string;
let orgId: string;
let nodeId: string;
let privateKey: KeyObject;

beforeAll(async () => {
  orgId = await createOrg();
  ({ nodeId, privateKey } = await createNode(orgId, { name: "streamer" }));
  app = await buildAgentApp();
  baseUrl = await listen(app);
  sessionManager = new Http2SessionManager(baseUrl);
});

afterAll(async () => {
  sessionManager.abort();
  await app.close();
});

type Message = MessageInitShape<typeof AgentMessageSchema>;

function client() {
  return createClient(NodeService, createConnectTransport({ baseUrl, httpVersion: "2", sessionManager }));
}

const hello: Message = {
  payload: {
    case: "hello",
    value: {
      agentVersion: "0.1.0",
      host: {
        hostname: "test-box", platform: "linux", arch: "amd64", osVersion: "6.8",
        agentVersion: "0.1.0", totalMemoryBytes: 68_719_476_736n, cpuCores: 16,
      },
    },
  },
};
const inventory = (...extra: { localId: string; kind: DeviceKind }[]): Message => ({
  payload: {
    case: "inventory",
    value: {
      devices: [
        { localId: "cuda:0", kind: DeviceKind.CUDA, name: "NVIDIA GeForce RTX 4090", totalBytes: 25_769_803_776n },
        ...extra,
      ],
    },
  },
});
const samples: Message = {
  payload: {
    case: "samples",
    value: {
      samples: [{
        localId: "cuda:0", usedBytes: 4_294_967_296n, utilization: 0.42,
        pressure: MemoryPressure.NORMAL, sampledAtUnixMs: BigInt(Date.now()),
      }],
    },
  },
};

/** Opens one authenticated stream, sends messages, and waits for the server to apply them. */
async function stream(messages: Message[], headers: Record<string, string> = { authorization: nodeAuthHeader(nodeId, privateKey) }) {
  async function* send() { yield* messages; }
  const responses = client().connect(send(), { headers });
  const first = await responses[Symbol.asyncIterator]().next();
  await sleep(300);
  return first.value;
}

const deviceRows = () => ownerDb.select().from(devices).where(eq(devices.nodeId, nodeId));
const nodeRow = async () => (await ownerDb.select().from(nodes).where(eq(nodes.id, nodeId)))[0]!;

describe("NodeService.Connect", () => {
  it("rejects an unauthenticated stream before applying anything it sent", async () => {
    const before = await nodeRow();
    const err = await stream([hello, inventory(), samples], {}).catch((e: unknown) => e);

    expect(ConnectError.from(err).code).toBe(Code.Unauthenticated);
    expect(await deviceRows()).toHaveLength(0);
    const after = await nodeRow();
    expect(after.status).toBe(before.status);
    expect(after.lastSeenAt).toEqual(before.lastSeenAt);
  });

  it("acknowledges hello, stores inventory, and records samples", async () => {
    const ack = await stream([hello, inventory(), samples]);
    expect(ack?.payload).toMatchObject({ case: "helloAck", value: { nodeId } });

    const [device] = await deviceRows();
    expect(device).toMatchObject({ localId: "cuda:0", kind: "cuda", totalBytes: 25_769_803_776n, lastUsedBytes: 4_294_967_296n });
    expect(device!.lastUtilization).toBeCloseTo(0.42);
    expect(await nodeRow()).toMatchObject({ status: "online", hostname: "test-box", cpuCores: 16 });
  });

  it("removes devices the node stops reporting, and drops unknown kinds", async () => {
    await ownerDb.insert(devices).values({ orgId, nodeId, localId: "cuda:9", kind: "cuda", name: "ghost" });
    await stream([inventory({ localId: "npu:0", kind: DeviceKind.UNSPECIFIED })]);
    expect((await deviceRows()).map((d) => d.localId)).toEqual(["cuda:0"]);
  });

  it("counts an empty sample batch as a heartbeat", async () => {
    await ownerDb.update(nodes).set({ status: "offline", lastSeenAt: new Date(Date.now() - 60_000) })
      .where(eq(nodes.id, nodeId));
    await stream([{ payload: { case: "samples", value: { samples: [] } } }]);

    const node = await nodeRow();
    expect(node.status).toBe("online");
    expect(node.lastSeenAt!.getTime()).toBeGreaterThan(Date.now() - 5_000);
  });

  it("marks a silent node degraded, then offline", async () => {
    await ownerDb.update(nodes).set({ status: "online", lastSeenAt: new Date(Date.now() - 20_000) })
      .where(eq(nodes.id, nodeId));
    await sweepOfflineNodes();
    expect((await nodeRow()).status).toBe("degraded");

    await ownerDb.update(nodes).set({ lastSeenAt: new Date(Date.now() - 40_000) }).where(eq(nodes.id, nodeId));
    await sweepOfflineNodes();
    expect((await nodeRow()).status).toBe("offline");
  });
});
