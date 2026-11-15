// Builds the host SDK as one stable ES module at dist/client/sdk.js so games
// can import it straight from the site. The banner points Deno-style tooling
// at the declarations scripts/sdk-dts.ts writes beside it.
import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    outDir: resolve(import.meta.dirname, "dist/client"),
    emptyOutDir: false,
    lib: { entry: resolve(import.meta.dirname, "src/client/sdk/host.ts"), formats: ["es"], fileName: () => "sdk.js" },
    rollupOptions: { output: { banner: '/* @ts-self-types="./sdk.d.ts" */' } },
  },
});
