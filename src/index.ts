import { clock, createDb, describeError } from "@i2bskn/workers-app-core";
import app from "./app";
import { sweepOrphanAttachments } from "./attachments/sweep";
import { core } from "./core";
import type { Bindings } from "./env";
import { purgeExpiredTrash } from "./pages/trash";

export type { AppType } from "./app";

export default {
  // OAuth and /mcp through OAuthProvider on origins that can host them, everything else through the app. The OAuth
  // paths are /mcp, /mcp/*, /oauth/*, /.well-known/* and /authorize: keep them in run_worker_first in wrangler.jsonc.
  fetch: core.fetch(app),

  // Daily (triggers.crons in wrangler.jsonc): deletes the pages that have been in the trash for 30 days, then
  // the attachment objects in R2 that no longer have a row. Uses the DB and R2 only, so it runs even when the
  // configuration is invalid. Awaited rather than passed to ctx.waitUntil, so that a failure is recorded as a
  // failed Cron run. Each step runs even if the other fails, and the first failure is thrown afterwards.
  async scheduled(_controller: ScheduledController, env: Bindings, _ctx: ExecutionContext): Promise<void> {
    const db = createDb(env.DB);
    const now = clock.now();
    const errors: unknown[] = [];
    try {
      const count = await purgeExpiredTrash(db, now);
      console.log("purged trash", { count });
    } catch (error) {
      console.error("purge trash failed", describeError(error));
      errors.push(error);
    }
    // After the purge, so that the objects of the pages it deleted go in the same run.
    try {
      const count = await sweepOrphanAttachments(db, env.ATTACHMENTS, now);
      console.log("swept attachments", { count });
    } catch (error) {
      console.error("sweep attachments failed", describeError(error));
      errors.push(error);
    }
    if (errors.length > 0) throw errors[0];
  },
} satisfies ExportedHandler<Bindings>;
