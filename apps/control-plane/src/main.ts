import { buildApp } from "./app.js";
import { env } from "./env.js";
import { startOfflineSweeper } from "./jobs/offline-sweeper.js";

const app = await buildApp();
await app.listen({ port: env.PORT, host: "0.0.0.0" });

// Only the real running process runs the sweep on its own clock. buildApp()
// deliberately does not start this: tests (and Task 18's end-to-end test)
// need to drive sweepOfflineNodes() manually rather than race a timer.
const stopSweeper = startOfflineSweeper();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.log.info("shutting down");
    stopSweeper();
    void app.close().then(() => process.exit(0));
  });
}
