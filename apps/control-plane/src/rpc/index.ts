import type { ConnectRouter } from "@connectrpc/connect";
import { registerNodeService } from "./node-service.js";

export function routes(router: ConnectRouter): void {
  registerNodeService(router);
}
