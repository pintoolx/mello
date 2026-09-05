import { defineConfig } from "vitest/config";
import { resolve } from "./vitest.shared.js";

export default defineConfig({
  resolve,
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "sellers/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/*.integration.test.ts", "**/node_modules/**", "**/generated/**"],
  },
});
