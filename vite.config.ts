// Builds the three pages (home, phone controller, demo host) into
// dist/client, which wrangler serves through the assets binding.
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  root: "src/client",
  publicDir: "public",
  plugins: [tailwindcss()],
  build: {
    outDir: resolve(import.meta.dirname, "dist/client"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "src/client/index.html"),
        pad: resolve(import.meta.dirname, "src/client/pad.html"),
        demo: resolve(import.meta.dirname, "src/client/demo.html"),
      },
    },
  },
});
