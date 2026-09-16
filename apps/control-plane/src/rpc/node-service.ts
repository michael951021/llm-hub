import type { ConnectRouter } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { NodeService } from "@modelhub/proto";
import { enrollNode, EnrollmentError } from "../domain/nodes.js";
import { PairingCodeError } from "../domain/pairing.js";

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
  });
}
