// vitest's defineConfig, not vite's — vite's does not accept the `test` key.
import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  // The rest of the repo keeps a single .env at the monorepo root (see
  // apps/control-plane/vitest.setup.ts) — point Vite's env loading there too
  // instead of expecting a second .env inside apps/web.
  envDir: path.resolve(__dirname, "../.."),
  server: {
    port: 5173,
    // Same-origin in dev so the session cookie works without CORS. Both
    // browser-facing surfaces (Better Auth's /api/auth/* and Connect's
    // FleetService) live on the control plane's port 3000 listener; the
    // agent's h2c port 3001 is never the browser's concern.
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
