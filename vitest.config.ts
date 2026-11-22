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
                // The login rate limit of wrangler.jsonc (5 per minute per email address) with a limit no test reaches:
                // the tests sign in as the same users many times a minute. The limit itself is tested in
                // @i2bskn/workers-app-core.
                ratelimits: {
                  LOGIN_RATE_LIMITER: { namespace_id: "4201", simple: { limit: 1_000_000, period: 60 } },
                },
                bindings: {
                  TEST_MIGRATIONS: migrations,
                  AUTH_MODE: "password",
                  JWT_SECRET: "test-secret-test-secret-test-secret-0123",
                  // PBKDF2 with few iterations instead of the default scrypt (about 150ms of CPU per hash), so that
                  // the setup, users, password changes and the dummy check at login stay fast. Same as
                  // TEST_HASH_CONFIG of test/helpers.ts; test/setup-login.test.ts checks the default scrypt once.
                  PASSWORD_HASH_ALGORITHM: "pbkdf2",
                  PASSWORD_PBKDF2_ITERATIONS: "10000",
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
