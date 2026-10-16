import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Placeholder values for the Worker's required secrets; wrangler reads them from process.env.
const testSecrets = { R2_ACCOUNT_ID: "test-account", R2_ACCESS_KEY_ID: "test-key", R2_SECRET_ACCESS_KEY: "test-secret", GITHUB_WEBHOOK_SECRET: "test-webhook-secret", GITHUB_APP_PRIVATE_KEY: "" };

export default defineConfig(async () => {
  Object.assign(process.env, testSecrets);
  const migrations = await readD1Migrations(new URL("./migrations", import.meta.url).pathname);
  return {
    test: {
      projects: [
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                bindings: { TEST_MIGRATIONS: migrations, WEBHOOK_TEST_SLACK: "https://hooks.example.com/test-slack" },
              },
            }),
          ],
          // Tests always run against the placeholder config at the repository root, whatever
          // DROP_DEPLOYMENT_DIR says.
          resolve: {
            alias: {
              "drop-deployment/config": new URL("../drop.config.json", import.meta.url).pathname,
              "drop-deployment/lock": new URL("../drop.config.lock.json", import.meta.url).pathname,
            },
          },
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
