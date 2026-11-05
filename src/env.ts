import type { AppEnv as CoreAppEnv, CoreBindings } from "@i2bskn/workers-app-core";

export { loadConfig, type AuthMode, type Config } from "@i2bskn/workers-app-core";

// Login, sessions, user management and MCP OAuth come from @i2bskn/workers-app-core (src/core.ts).
export type Bindings = CoreBindings & {
  // The contents of attachments. Not checked by loadConfig: `wrangler deploy` always creates it.
  ATTACHMENTS: R2Bucket;
};

export type AppEnv = CoreAppEnv<Bindings>;
