import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/contracts/src/**/*.contract.test.ts"],
  },
});
