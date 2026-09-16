import { buildApp } from "./app.js";
import { buildAgentApp } from "./agent-app.js";
import { env } from "./env.js";
import { startOfflineSweeper } from "./jobs/offline-sweeper.js";

const app = await buildApp();
await app.listen({ port: env.PORT, host: "0.0.0.0" });

// A separate server, on its own port: browsers can't speak the cleartext
// HTTP/2 that NodeService.Connect's bidi stream needs. See agent-app.ts.
const agentApp = await buildAgentApp();
await agentApp.listen({ port: env.AGENT_PORT, host: "0.0.0.0" });

// Only the real running process runs the sweep on its own clock. buildApp()
// deliberately does not start this: tests (and Task 18's end-to-end test)
// need to drive sweepOfflineNodes() manually rather than race a timer.
const stopSweeper = startOfflineSweeper();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.log.info("shutting down");
    stopSweeper();
    void Promise.all([app.close(), agentApp.close()]).then(() => process.exit(0));
  });
}
