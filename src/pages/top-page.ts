import { eq } from "drizzle-orm";
import { clock } from "../clock";
import type { Db } from "../db/client";
import { siteSettings, type PageRow, type UserRow } from "../db/schema";
import { findSpaceById } from "../spaces/queries";
import { findAccessiblePage, findAccessiblePageIncludingTrash, findPageById } from "./queries";

// The page shown at the top of the home screen, chosen by an admin. Only a page in an everyone space that is
// not archived, and not in the trash, is chosen and shown, so it is the same for every signed-in user.

const SETTINGS_ID = 1;

// Returns the top page only while it is in an everyone space that is not archived and not in the trash,
// otherwise null. The setting is kept, so the page is shown again once it is moved back, restored or the
// space is unarchived.
export async function getTopPage(db: Db): Promise<PageRow | null> {
  const settings = await db.select().from(siteSettings).where(eq(siteSettings.id, SETTINGS_ID)).get();
  if (!settings?.topPageId) return null;
  const page = await findPageById(db, settings.topPageId);
  if (!page || page.deletedAt !== null) return null;
  const space = await findSpaceById(db, page.spaceId);
  if (!space || space.kind !== "everyone" || space.archivedAt !== null) return null;
  return page;
}

export type SetTopPageResult =
  | { ok: true; page: PageRow | null }
  | { ok: false; error: "not_found" | "space_archived" | "not_everyone_space" };

// Sets the top page, or clears it with null. The caller checks that the user is an admin.
export async function setTopPage(db: Db, admin: UserRow, pageId: string | null): Promise<SetTopPageResult> {
  const now = clock.now();
  if (pageId === null) {
    await db
      .insert(siteSettings)
      .values({ id: SETTINGS_ID, topPageId: null, updatedBy: admin.id, updatedAt: now })
      .onConflictDoUpdate({
        target: siteSettings.id,
        set: { topPageId: null, updatedBy: admin.id, updatedAt: now },
      })
      .run();
    return { ok: true, page: null };
  }

  // Decided as the admin sees the page, so that whether another user's personal space is archived is not
  // revealed. The other errors are decided after the statement below.
  const before = await findAccessiblePageIncludingTrash(db, admin, pageId);
  if (!before || before.page.deletedAt !== null) return { ok: false, error: "not_found" };
  if (before.space.archivedAt !== null) return { ok: false, error: "space_archived" };

  // One statement, so a page moved out of its everyone space or put in the trash, or a space archived, after
  // any check is not chosen.
  const row = await db.$client
    .prepare(
      `INSERT INTO site_settings (id, top_page_id, updated_by, updated_at)
      SELECT 1, p.id, ?, ? FROM pages p
      WHERE p.id = ? AND p.deleted_at IS NULL
        AND p.space_id IN (SELECT id FROM spaces WHERE kind = 'everyone' AND archived_at IS NULL)
      ON CONFLICT (id) DO UPDATE SET top_page_id = excluded.top_page_id,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at
      RETURNING top_page_id`,
    )
    .bind(admin.id, now, pageId)
    .first<{ top_page_id: string }>();
  if (!row) {
    // Decide the error as the admin sees the page, so that another user's personal space is not revealed.
    const found = await findAccessiblePageIncludingTrash(db, admin, pageId);
    if (!found || found.page.deletedAt !== null) return { ok: false, error: "not_found" };
    if (found.space.archivedAt !== null) return { ok: false, error: "space_archived" };
    if (found.space.kind !== "everyone") return { ok: false, error: "not_everyone_space" };
    // Moved back to an everyone space after the statement ran.
    return { ok: false, error: "not_found" };
  }
  // Not findPageById: the page may have moved to another user's personal space in between.
  const page = await findAccessiblePage(db, admin, row.top_page_id);
  if (!page) return { ok: false, error: "not_found" };
  return { ok: true, page };
}
