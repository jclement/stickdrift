// Tests run inside workerd via the Cloudflare Vitest plugin, against the
// real Worker and Durable Object, with isolated storage per test file.
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: { include: ["test/**/*.test.ts"] },
});
