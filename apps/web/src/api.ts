import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { FleetService } from "@modelhub/proto";

// Same-origin: the session cookie rides along, and there is no CORS to
// manage. This must stay pointed at PORT (3000, proxied to 5173 in dev) —
// the agent's h2c listener on 3001 is not something a browser can speak to
// at all.
//
// connect-web 2.x's ConnectTransportOptions has no top-level `credentials`
// field (unlike some earlier sketches of this API) — the fetch docstring
// itself says credentials belong on a custom `fetch` override.
const transport = createConnectTransport({
  baseUrl: window.location.origin,
  fetch: (input, init) => fetch(input, { ...init, credentials: "include" }),
});

export const fleetClient = createClient(FleetService, transport);
