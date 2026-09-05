import "dotenv/config";
import { defineConfig } from "vitest/config";
import { resolve } from "./vitest.shared.js";

export default defineConfig({
  resolve,
  test: {
    environment: "node",
    env: { RUN_INTEGRATION_TESTS: "true" },
    globalSetup: ["./scripts/integration-database-global-setup.ts"],
    include: ["src/**/*.integration.test.ts", "sellers/**/*.integration.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    // Suites share a dedicated integration database and exercise demo reset.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
