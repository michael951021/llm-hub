import type { ConnectRouter, HandlerContext } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { NodeService, type AgentMessage } from "@modelhub/proto";
import {
  enrollNode, EnrollmentError, markNodeOnline, recordInventory, recordSamples,
} from "../domain/nodes.js";
import { PairingCodeError } from "../domain/pairing.js";
import { authenticateNode } from "./node-auth.js";
import { env } from "../env.js";

export function registerNodeService(router: ConnectRouter): void {
  router.service(NodeService, {
    async enroll(req) {
      try {
        const result = await enrollNode({
          pairingCode: req.pairingCode,
          publicKey: req.publicKey,
          nodeName: req.nodeName,
          host: {
            hostname: req.host?.hostname ?? "",
            platform: req.host?.platform ?? "",
            arch: req.host?.arch ?? "",
            osVersion: req.host?.osVersion ?? "",
            agentVersion: req.host?.agentVersion ?? "",
            totalMemoryBytes: req.host?.totalMemoryBytes ?? 0n,
            cpuCores: req.host?.cpuCores ?? 0,
          },
        });
        return {
          nodeId: result.nodeId,
          orgId: result.orgId,
          orgName: result.orgName,
        };
      } catch (err) {
        // Neither error carries a typed discriminant beyond its message —
        // pass the message through so an enrolling agent's operator can
        // tell "expired" from "already used" from "wrong key length"
        // rather than getting an opaque `internal`.
        if (err instanceof PairingCodeError || err instanceof EnrollmentError) {
          throw new ConnectError(err.message, Code.InvalidArgument);
        }
        throw err;
      }
    },

    // The incoming stream is typed against the real generated AgentMessage
    // (not `any`): Connect's bidi typing infers the client-facing shape of
    // `router.service()` from the schema regardless of what's written here,
    // so this annotation buys real narrowing on `message.payload.case`
    // below without costing anything. The outgoing side is intentionally
    // left to be inferred as plain object literals (see the `yield`s
    // below): annotating it as `AsyncIterable<ServerMessage>` forces every
    // yielded value to satisfy the full generated `Message` type, which
    // requires a `$typeName` field that only `create(ServerMessageSchema, …)`
    // populates — the same plain-literal shape `enroll`'s return already
    // uses successfully is enough here, and router.service() accepts it.
    async *connect(requests: AsyncIterable<AgentMessage>, ctx: HandlerContext) {
      // Authenticate before touching anything the stream sends: this must
      // be the very first thing that happens, before a single message is
      // read off `requests`, so an unauthenticated caller can never cause
      // a write. A thrown NodeAuthError here terminates the stream before
      // the generator yields anything — the client sees it as the RPC
      // failing, not as a message.
      const { nodeId, orgId } = await authenticateNode(
        ctx.requestHeader.get("authorization") ?? undefined,
      );

      yield {
        payload: {
          case: "helloAck",
          value: { nodeId, sampleIntervalMs: env.SAMPLE_INTERVAL_MS },
        },
      };

      for await (const message of requests) {
        switch (message.payload.case) {
          case "hello":
            await markNodeOnline(orgId, nodeId, {
              hostname: message.payload.value.host?.hostname ?? "",
              platform: message.payload.value.host?.platform ?? "",
              arch: message.payload.value.host?.arch ?? "",
              osVersion: message.payload.value.host?.osVersion ?? "",
              agentVersion: message.payload.value.agentVersion ?? "",
              totalMemoryBytes: message.payload.value.host?.totalMemoryBytes ?? 0n,
              cpuCores: message.payload.value.host?.cpuCores ?? 0,
            });
            break;
          case "inventory":
            await recordInventory(orgId, nodeId, message.payload.value.devices);
            break;
          case "samples":
            await recordSamples(orgId, nodeId, message.payload.value.samples);
            break;
          default:
            break;
        }
      }
    },
  });
}
