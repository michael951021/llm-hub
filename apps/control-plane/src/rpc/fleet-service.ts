import type { ConnectRouter, HandlerContext } from "@connectrpc/connect";
import { ConnectError, Code } from "@connectrpc/connect";
import { asc, eq } from "drizzle-orm";
import { withOrg, nodes, devices } from "@modelhub/db";
import { FleetService } from "@modelhub/proto";
import { requireSession, HttpError, type SessionContext } from "../auth/session.js";
import { mintPairingCode } from "../domain/pairing.js";
import { buildNodeView } from "../domain/views.js";

// Connect hands us its own context; requireSession wants something header-shaped.
function asRequest(ctx: HandlerContext) {
  const headers: Record<string, string> = {};
  ctx.requestHeader.forEach((value, key) => { headers[key.toLowerCase()] = value; });
  return { headers };
}

async function session(ctx: HandlerContext): Promise<SessionContext> {
  try {
    return await requireSession(asRequest(ctx));
  } catch (err) {
    // requireSession signals both "no session" (401) and "no organization"
    // (403) as HttpError; either way this API only needs "you're not in",
    // so both collapse to Unauthenticated. Anything else — a genuine
    // internal fault inside requireSession, e.g. the DB or Better Auth
    // itself failing — is deliberately NOT caught here: it rethrows and
    // falls through to Connect's default mapping to Internal, the same
    // way an uncaught error anywhere else in a handler would.
    if (err instanceof HttpError) {
      throw new ConnectError("sign in required", Code.Unauthenticated);
    }
    throw err;
  }
}

export function registerFleetService(router: ConnectRouter): void {
  router.service(FleetService, {
    async listNodes(_req, ctx) {
      const { orgId } = await session(ctx);
      return withOrg(orgId, async (tx) => {
        const nodeRows = await tx.select().from(nodes).orderBy(asc(nodes.name));
        const deviceRows = await tx.select().from(devices).orderBy(asc(devices.localId));
        return {
          nodes: nodeRows.map((n) =>
            buildNodeView(n, deviceRows.filter((d) => d.nodeId === n.id)),
          ),
        };
      });
    },

    async getNode(req, ctx) {
      const { orgId } = await session(ctx);
      return withOrg(orgId, async (tx) => {
        const [node] = await tx.select().from(nodes).where(eq(nodes.id, req.nodeId)).limit(1);
        if (!node) throw new ConnectError("node not found", Code.NotFound);
        const deviceRows = await tx.select().from(devices)
          .where(eq(devices.nodeId, node.id)).orderBy(asc(devices.localId));
        return { node: buildNodeView(node, deviceRows) };
      });
    },

    async createPairingCode(req, ctx) {
      const { orgId, userId } = await session(ctx);
      const { code, expiresAt } = await mintPairingCode(orgId, userId, req.nodeName);
      return { code, expiresAtUnixMs: BigInt(expiresAt.getTime()) };
    },
  });
}
