import type { AppEnv as CoreAppEnv, CoreBindings } from "@i2bskn/workers-app-core";

export { loadConfig, type AuthMode, type Config } from "@i2bskn/workers-app-core";

// Login, sessions, user management and MCP OAuth come from @i2bskn/workers-app-core (src/core.ts).
export type Bindings = CoreBindings & {
  // The contents of attachments. Not checked by loadConfig: `wrangler deploy` always creates it.
  ATTACHMENTS: R2Bucket;
  // Browser Rendering (Browser Run), used only when PDF_RENDERER is "browser" (src/pdf/renderer.ts).
  BROWSER?: BrowserRun;
  // "browser" makes the PDFs of pages on the server with BROWSER; anything else leaves it to the print dialog of
  // the browser.
  PDF_RENDERER?: string;
};

export type AppEnv = CoreAppEnv<Bindings>;
