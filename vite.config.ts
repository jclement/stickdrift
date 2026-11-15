// Builds the three pages (home, phone controller, demo host) into
// dist/client, which wrangler serves through the assets binding.
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

// BUILD identifies this deploy (set by `mise run deploy`); the phone
// compares it with /api/v1/health to notice a new deploy and reload itself.
const BUILD = process.env.BUILD ?? "dev";

export default defineConfig({
  define: { __BUILD__: JSON.stringify(BUILD) },
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
