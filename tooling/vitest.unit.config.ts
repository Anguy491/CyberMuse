import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: [
      "packages/domain/src/**/*.test.ts",
      "packages/audio/src/**/*.test.ts",
      "packages/scoring/src/**/*.test.ts",
      "apps/desktop/src/**/*.test.{ts,tsx}",
    ],
    exclude: ["**/*.contract.test.ts"],
    setupFiles: ["apps/desktop/src/setup-tests.ts"],
  },
});
