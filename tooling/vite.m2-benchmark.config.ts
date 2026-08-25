import { resolve } from "node:path";

import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      "@cybermuse/audio": resolve("packages/audio/src/index.ts"),
      "@cybermuse/domain": resolve("packages/domain/src/index.ts"),
    },
  },
  build: {
    emptyOutDir: true,
    lib: {
      entry: resolve("tooling/m2-realtime-benchmark.ts"),
      formats: ["es"],
      fileName: () => "m2-realtime-benchmark.mjs",
    },
    minify: true,
    outDir: resolve("artifacts/m2/benchmark-bundle"),
    rollupOptions: {
      external: [/^node:/],
    },
    target: "node24",
  },
});
