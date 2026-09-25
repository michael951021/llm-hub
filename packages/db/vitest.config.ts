import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { setupFiles: ["../../vitest.env.ts"] },
});
