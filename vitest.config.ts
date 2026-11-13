import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("drizzle/migrations");
  return {
    test: {
      projects: [
        // Worker tests, run in workerd.
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                // An empty D1 for the test of migration 0011 (test/migration-0011.test.ts), which applies the
                // migrations itself. setup.ts applies nothing to it.
                d1Databases: ["MIGRATION_DB"],
                bindings: {
                  TEST_MIGRATIONS: migrations,
                  AUTH_MODE: "password",
                  JWT_SECRET: "test-secret-test-secret-test-secret-0123",
                },
              },
            }),
          ],
          test: {
            name: "worker",
            include: ["test/**/*.test.ts"],
            setupFiles: ["./test/setup.ts"],
            testTimeout: 30000,
          },
        },
        // Client tests that need no browser, run in Node.
        {
          test: {
            name: "client",
            include: ["client/**/*.test.{ts,tsx}"],
            environment: "node",
          },
        },
      ],
    },
  };
});
