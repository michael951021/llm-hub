import { buildAgentApp, buildApp } from "./server.js";
import { env } from "./env.js";
import { startOfflineSweeper } from "./jobs/offline-sweeper.js";

const app = await buildApp();
await app.listen({ port: env.PORT, host: "0.0.0.0" });

const agentApp = await buildAgentApp();
await agentApp.listen({ port: env.AGENT_PORT, host: "0.0.0.0" });

// Only the real process runs the sweep on a timer; tests call
// sweepOfflineNodes() directly with their own clock.
const stopSweeper = startOfflineSweeper();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.log.info("shutting down");
    stopSweeper();
    void Promise.all([app.close(), agentApp.close()]).then(() => process.exit(0));
  });
}
