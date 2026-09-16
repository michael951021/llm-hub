import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // The enroll+connect test and the offline-sweep test both do real
    // network and process work against a real database; run them one at
    // a time rather than in parallel workers.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
