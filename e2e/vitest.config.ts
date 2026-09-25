import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["../vitest.env.ts"],
    // Builds and runs a real agent process against a real database.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
