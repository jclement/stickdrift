// Tests run inside workerd via the Cloudflare Vitest plugin, against the
// real Worker and Durable Object, with isolated storage per test file.
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  // css.include: let test/client/pad-css.test.ts import pad.css?raw (by
  // default vitest hands tests an empty string for CSS).
  test: { include: ["test/**/*.test.ts"], css: { include: [/pad\.css/] } },
});
