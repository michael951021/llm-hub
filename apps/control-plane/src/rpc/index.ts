import type { ConnectRouter } from "@connectrpc/connect";
import { registerNodeService } from "./node-service.js";

/**
 * Services exposed to authenticated browser sessions, over HTTP/1.1 —
 * mounted on `buildApp()`. Task 11 adds FleetService here.
 */
export function browserRoutes(_router: ConnectRouter): void {
  // FleetService lands here in Task 11.
}

/**
 * Services exposed to enrolling/enrolled agents, over HTTP/2 (cleartext
 * h2c) — mounted on `buildAgentApp()`. NodeService.Connect is a true bidi
 * stream, which needs HTTP/2 framing that browsers can't speak without
 * TLS; NodeService.Enroll rides along on the same service and app since
 * it's the same caller (an agent) and the same generated service type.
 */
export function agentRoutes(router: ConnectRouter): void {
  registerNodeService(router);
}
