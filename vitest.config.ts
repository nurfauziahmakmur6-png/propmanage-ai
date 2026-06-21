import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Pipeline tests share Redis/DB; run files serially to avoid cross-talk.
    fileParallelism: false,
  },
});
