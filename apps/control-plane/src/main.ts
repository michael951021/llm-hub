import { buildApp } from "./app.js";
import { env } from "./env.js";

const app = await buildApp();
await app.listen({ port: env.PORT, host: "0.0.0.0" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.log.info("shutting down");
    void app.close().then(() => process.exit(0));
  });
}
