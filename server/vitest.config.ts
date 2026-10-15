import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(new URL("./migrations", import.meta.url).pathname);
  return {
    test: {
      projects: [
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
            }),
          ],
          test: {
            name: "worker",
            include: ["test/worker/**/*.test.ts"],
            setupFiles: ["test/worker/apply-migrations.ts"],
          },
        },
        {
          test: {
            name: "node",
            include: ["test/node/**/*.test.ts"],
            environment: "node",
          },
        },
      ],
    },
  };
});
