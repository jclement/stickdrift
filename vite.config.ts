// Builds the pages (games home, build-your-own, phone controller, demo
// host, docs, layout designer) into dist/client, which wrangler serves through the assets
// binding. Static assets are served with Cloudflare's default HTML
// handling, so docs.html answers at /docs and designer.html at /designer.
//
// The docs plugin renders docs/*.md and PROTOCOL.md into docs.html at build
// time (the page ships as plain HTML), and publishes the same Markdown raw
// at /docs/<slug>.md and /agents.md so agents can read it without a browser.
import { defineConfig, type Plugin } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildDocs } from "./src/client/site/docs-build";
import { DOC_SECTIONS } from "./src/client/site/docs-index";

const repo = import.meta.dirname;
const read = (file: string) => readFileSync(resolve(repo, file), "utf8");

/** docsPlugin fills docs.html and emits the raw Markdown files. */
function docsPlugin(): Plugin {
  return {
    name: "stickdrift-docs",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        if (!ctx.filename.endsWith("docs.html")) return html;
        const page = buildDocs(read);
        return html.replace("<!--DOCS-NAV-->", page.nav).replace("<!--DOCS-BODY-->", page.body);
      },
    },
    buildStart() {
      for (const s of DOC_SECTIONS) this.addWatchFile(resolve(repo, s.file));
    },
    generateBundle() {
      for (const s of DOC_SECTIONS) this.emitFile({ type: "asset", fileName: `docs/${s.slug}.md`, source: read(s.file) });
      this.emitFile({ type: "asset", fileName: "agents.md", source: read("docs/agents.md") });
    },
  };
}

// BUILD identifies this deploy (set by `mise run deploy`); the phone
// compares it with /api/v1/health to notice a new deploy and reload itself.
const BUILD = process.env.BUILD ?? "dev";

export default defineConfig({
  define: { __BUILD__: JSON.stringify(BUILD) },
  root: "src/client",
  publicDir: "public",
  plugins: [tailwindcss(), docsPlugin()],
  build: {
    outDir: resolve(repo, "dist/client"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(repo, "src/client/index.html"),
        build: resolve(repo, "src/client/build.html"),
        pad: resolve(repo, "src/client/pad.html"),
        demo: resolve(repo, "src/client/demo.html"),
        docs: resolve(repo, "src/client/docs.html"),
        designer: resolve(repo, "src/client/designer.html"),
      },
    },
  },
});
