import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { FleetService } from "@modelhub/proto";

// Same-origin (proxied to PORT in dev), so the session cookie rides along.
// connect-web takes credentials via a custom fetch.
const transport = createConnectTransport({
  baseUrl: window.location.origin,
  fetch: (input, init) => fetch(input, { ...init, credentials: "include" }),
});

export const fleetClient = createClient(FleetService, transport);
