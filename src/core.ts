import { createCore, describeError, type CoreHooks } from "@i2bskn/workers-app-core";
import { attachmentKey } from "./attachments/service";
import type { Bindings } from "./env";
import { registerTools } from "./mcp/tools";
import { insertPersonalSpaceStatement } from "./spaces/queries";
import { ConsentPage } from "./views/consent";
import { Layout } from "./views/layout";

// What userDeleteStatements passes to afterUserDeleted: the attachments deleted with the personal space.
type DeleteData = { attachmentIds: string[] };

// R2 deletes up to 1,000 keys per call.
const R2_DELETE_BATCH = 1000;

const hooks: CoreHooks<Bindings, DeleteData> = {
  // Every new user gets a personal space, in the same batch as the INSERT of the user. The statement inserts
  // nothing unless the user exists, so it also holds when the INSERT of the setup inserts nothing.
  userCreatedStatements: (d1, userId, now) => [insertPersonalSpaceStatement(d1, userId, now)],

  // Creates the personal space if missing. Users created by older code (between the migration and the deploy, or
  // after a rollback) have none. A no-op read when it already exists. Errors propagate so that the login fails
  // instead of leaving the user without a personal space.
  async beforeSessionIssued({ db, userId, now }) {
    await insertPersonalSpaceStatement(db.$client, userId, now).run();
  },

  // Deletes the user's personal space and everything in it: pages including the trash, folders, revisions and
  // attachment rows. Content in other spaces stays; its created_by and updated_by become NULL (ON DELETE SET NULL).
  // The user's rows of space_members are deleted with the user by ON DELETE CASCADE, so they need no statement here.
  async userDeleteStatements({ d1, userId, guard }) {
    const personalSpaces = `SELECT id FROM spaces WHERE owner_user_id = ?1 AND kind = 'personal'`;
    // Children first: attachments (their IDs are decided here, in the same transaction, so that a page moved
    // out of the space beforehand keeps its object), pages with their revisions by ON DELETE CASCADE, folders
    // in one statement (parent_id is checked at its end), then the space. The sessions and the user follow.
    return {
      statements: [
        d1
          .prepare(
            `DELETE FROM attachments WHERE page_id IN (SELECT id FROM pages WHERE space_id IN (${personalSpaces}))
            AND ${guard} RETURNING id`,
          )
          .bind(userId),
        d1.prepare(`DELETE FROM pages WHERE space_id IN (${personalSpaces}) AND ${guard}`).bind(userId),
        d1.prepare(`DELETE FROM folders WHERE space_id IN (${personalSpaces}) AND ${guard}`).bind(userId),
        d1.prepare(`DELETE FROM spaces WHERE owner_user_id = ?1 AND kind = 'personal' AND ${guard}`).bind(userId),
      ],
      read: (results) => ({
        attachmentIds: ((results[0]?.results ?? []) as { id: string }[]).map((row) => row.id),
      }),
    };
  },

  // The objects in R2 of the deleted attachments, best effort. Objects left by an R2 failure are deleted by the
  // scheduled job (src/attachments/sweep.ts).
  async afterUserDeleted({ env, userId, data }) {
    try {
      const keys = data.attachmentIds.map(attachmentKey);
      for (let i = 0; i < keys.length; i += R2_DELETE_BATCH) {
        await env.ATTACHMENTS.delete(keys.slice(i, i + R2_DELETE_BATCH));
      }
    } catch (error) {
      console.error("attachment objects delete after user delete failed", { userId, ...describeError(error) });
    }
  },
};

// Login, sessions, user management and the MCP OAuth authorization server.
export const core = createCore<Bindings, {}, {}, undefined, DeleteData>({
  brand: { id: "libreno", name: "libreno", layout: Layout },
  hooks,
  mcp: {
    serverInfo: { name: "libreno", version: "0.0.0" },
    register: (server, { db, user, env }) => registerTools(server, { db, user, attachments: env.ATTACHMENTS }),
  },
  consent: { render: (props) => ConsentPage(props) },
});
