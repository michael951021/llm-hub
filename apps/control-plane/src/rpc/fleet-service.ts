import { Code, ConnectError, type ConnectRouter, type HandlerContext } from "@connectrpc/connect";
import { asc, eq } from "drizzle-orm";
import { devices, isUuid, nodes, withOrg } from "@modelhub/db";
import { FleetService } from "@modelhub/proto";
import { HttpError, requireSession } from "../auth/session.js";
import { mintPairingCode } from "../domain/pairing.js";
import { nodeView } from "../domain/wire.js";

// Pure reads query inline through withOrg(); anything with an invariant
// (pairing codes, enrollment, inventory) goes through domain/.

async function session(ctx: HandlerContext) {
  try {
    return await requireSession(ctx.requestHeader);
  } catch (err) {
    // No session (401) and no organization (403) both mean "you're not in".
    // Anything else is a genuine fault and falls through to Internal.
    if (err instanceof HttpError) throw new ConnectError("sign in required", Code.Unauthenticated);
    throw err;
  }
}

const notFound = () => new ConnectError("node not found", Code.NotFound);

export function registerFleetService(router: ConnectRouter): void {
  router.service(FleetService, {
    async listNodes(_req, ctx) {
      const { orgId } = await session(ctx);
      return withOrg(orgId, async (tx) => {
        const nodeRows = await tx.select().from(nodes).orderBy(asc(nodes.name));
        const deviceRows = await tx.select().from(devices).orderBy(asc(devices.localId));
        return { nodes: nodeRows.map((n) => nodeView(n, deviceRows.filter((d) => d.nodeId === n.id))) };
      });
    },

    // A malformed id, an absent id, and another org's id are all the same
    // NotFound, so this can't be used to probe for nodes in other orgs.
    async getNode(req, ctx) {
      const { orgId } = await session(ctx);
      if (!isUuid(req.nodeId)) throw notFound();
      return withOrg(orgId, async (tx) => {
        const [node] = await tx.select().from(nodes).where(eq(nodes.id, req.nodeId)).limit(1);
        if (!node) throw notFound();
        const deviceRows = await tx.select().from(devices)
          .where(eq(devices.nodeId, node.id)).orderBy(asc(devices.localId));
        return { node: nodeView(node, deviceRows) };
      });
    },

    async createPairingCode(req, ctx) {
      const { orgId, userId } = await session(ctx);
      const { code, expiresAt } = await mintPairingCode(orgId, userId, req.nodeName);
      return { code, expiresAtUnixMs: BigInt(expiresAt.getTime()) };
    },
  });
}
