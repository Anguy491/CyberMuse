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
      entry: resolve("tooling/m8-pitch-quality.ts"),
      formats: ["es"],
      fileName: () => "m8-pitch-quality.mjs",
    },
    minify: true,
    outDir: resolve("artifacts/m8/quality-bundle"),
    rollupOptions: { external: [/^node:/] },
    target: "node24",
  },
});
