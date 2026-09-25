import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { NodeService, type AgentMessage } from "@modelhub/proto";
import { enrollNode, EnrollmentError, markNodeOnline, recordInventory, recordSamples } from "../domain/nodes.js";
import { PairingCodeError } from "../domain/pairing.js";
import { hostColumns } from "../domain/wire.js";
import { env } from "../env.js";
import { authenticateNode } from "./node-auth.js";

export function registerNodeService(router: ConnectRouter): void {
  router.service(NodeService, {
    // Unauthenticated: the pairing code is the credential.
    async enroll(req) {
      try {
        return await enrollNode({
          pairingCode: req.pairingCode,
          publicKey: req.publicKey,
          nodeName: req.nodeName,
          host: hostColumns(req.host),
        });
      } catch (err) {
        // Pass the reason through ("expired", "already used", ...) so the
        // operator running `enroll` can act on it.
        if (err instanceof PairingCodeError || err instanceof EnrollmentError) {
          throw new ConnectError(err.message, Code.InvalidArgument);
        }
        throw err;
      }
    },

    // The outgoing side is left to inference: plain object literals are
    // accepted, while an explicit ServerMessage type would demand $typeName.
    async *connect(requests: AsyncIterable<AgentMessage>, ctx) {
      // Before reading a single message, so an unauthenticated caller can
      // never cause a write.
      const { nodeId, orgId } = await authenticateNode(ctx.requestHeader.get("authorization"));

      yield { payload: { case: "helloAck", value: { nodeId, sampleIntervalMs: env.SAMPLE_INTERVAL_MS } } };

      for await (const { payload } of requests) {
        switch (payload.case) {
          case "hello":
            await markNodeOnline(orgId, nodeId, {
              ...hostColumns(payload.value.host),
              agentVersion: payload.value.agentVersion,
            });
            break;
          case "inventory":
            await recordInventory(orgId, nodeId, payload.value.devices);
            break;
          case "samples":
            await recordSamples(orgId, nodeId, payload.value.samples);
            break;
        }
      }
    },
  });
}
