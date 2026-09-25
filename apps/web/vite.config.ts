// vitest's defineConfig, not vite's — vite's does not accept the `test` key.
import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  // One .env for the whole monorepo, at its root.
  envDir: path.resolve(__dirname, "../.."),
  server: {
    port: 5173,
    // Same-origin in dev so the session cookie works without CORS.
    proxy: {
      "/api": "http://localhost:3000",
      "/modelhub.v1.FleetService": "http://localhost:3000",
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
});
