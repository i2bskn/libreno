import { and, asc, desc, eq, isNotNull, isNull, lte } from "drizzle-orm";
import { clock } from "../clock";
import type { Db } from "../db/client";
import { pages, type PageRow, type UserRow } from "../db/schema";
import { canAccessSpace, type SpaceViewer } from "../spaces/access";
import { isSpaceArchived, spaceNotArchived } from "../spaces/archive";
import { findSpaceById } from "../spaces/queries";
import { findAccessiblePageIncludingTrash, findPageById } from "./queries";

// Shared by the REST API and the MCP tools. Deleting a page moves it to the trash of its space, where it
// stays for TRASH_RETENTION_DAYS before the scheduled job (purgeExpiredTrash) deletes it.
// D1 has no interactive transactions, so each write is one conditional statement.

export const TRASH_RETENTION_DAYS = 30;
export const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

// A page in the trash without its body. deletedAt is set (see toApiTrashedPage).
export type TrashedPageRow = Omit<PageRow, "body">;

export type TrashPageResult = { ok: true } | { ok: false; error: "not_found" | "space_archived" };

// Moves the page to the trash. The version, updated_at and updated_by do not change, and no revision is kept.
export async function trashPage(db: Db, user: UserRow, pageId: string): Promise<TrashPageResult> {
  const found = await findAccessiblePageIncludingTrash(db, user, pageId);
  if (!found || found.page.deletedAt !== null) return { ok: false, error: "not_found" };
  const { page } = found;
  if (found.space.archivedAt !== null) return { ok: false, error: "space_archived" };
  // space_id keeps the write inside the space whose access was just checked.
  const result = await db
    .update(pages)
    .set({ deletedAt: clock.now(), deletedBy: user.id })
    .where(
      and(
        eq(pages.id, page.id),
        eq(pages.spaceId, page.spaceId),
        isNull(pages.deletedAt),
        spaceNotArchived(page.spaceId),
      ),
    )
    .run();
  if (result.meta.changes === 1) return { ok: true };
  // Access is not checked again: the page was visible just before.
  const current = await findPageById(db, page.id);
  if (!current || current.spaceId !== page.spaceId || current.deletedAt !== null) {
    return { ok: false, error: "not_found" };
  }
  if (await isSpaceArchived(db, page.spaceId)) return { ok: false, error: "space_archived" };
  return { ok: false, error: "not_found" };
}

export type ListTrashResult = { ok: true; pages: TrashedPageRow[] } | { ok: false; error: "space_not_found" };

// Lists the pages in the trash of the space, most recently deleted first, without reading their bodies.
// Spaces the viewer cannot access are reported as missing so that their existence is not revealed.
export async function listTrash(db: Db, viewer: SpaceViewer, spaceId: string): Promise<ListTrashResult> {
  const space = await findSpaceById(db, spaceId);
  if (!space || !canAccessSpace(viewer, space)) return { ok: false, error: "space_not_found" };
  const rows = await db
    .select({
      id: pages.id,
      spaceId: pages.spaceId,
      folderId: pages.folderId,
      title: pages.title,
      version: pages.version,
      createdBy: pages.createdBy,
      updatedBy: pages.updatedBy,
      createdAt: pages.createdAt,
      updatedAt: pages.updatedAt,
      deletedAt: pages.deletedAt,
      deletedBy: pages.deletedBy,
    })
    .from(pages)
    .where(and(eq(pages.spaceId, space.id), isNotNull(pages.deletedAt)))
    .orderBy(desc(pages.deletedAt), asc(pages.id))
    .all();
  return { ok: true, pages: rows };
}

// Reports why a conditional write on a page in the trash changed no rows. Access is not checked again:
// the page was visible just before.
async function trashWriteFailure(
  db: Db,
  page: Pick<PageRow, "id" | "spaceId">,
): Promise<{ ok: false; error: "not_found" | "space_archived" | "not_in_trash" }> {
  const current = await findPageById(db, page.id);
  if (!current || current.spaceId !== page.spaceId) return { ok: false, error: "not_found" };
  if (await isSpaceArchived(db, page.spaceId)) return { ok: false, error: "space_archived" };
  if (current.deletedAt === null) return { ok: false, error: "not_in_trash" };
  return { ok: false, error: "not_found" };
}

export type RestoreTrashedPageResult =
  | { ok: true; page: PageRow }
  | { ok: false; error: "not_found" | "space_archived" | "not_in_trash" };

// Moves the page out of the trash. The version and updated_at do not change. The folder stays as it is;
// it is already the top level if the folder was deleted while the page was in the trash.
export async function restoreTrashedPage(
  db: Db,
  viewer: SpaceViewer,
  pageId: string,
): Promise<RestoreTrashedPageResult> {
  const found = await findAccessiblePageIncludingTrash(db, viewer, pageId);
  if (!found) return { ok: false, error: "not_found" };
  const { page } = found;
  if (found.space.archivedAt !== null) return { ok: false, error: "space_archived" };
  if (page.deletedAt === null) return { ok: false, error: "not_in_trash" };
  const restored = await db
    .update(pages)
    .set({ deletedAt: null, deletedBy: null })
    .where(
      and(
        eq(pages.id, page.id),
        eq(pages.spaceId, page.spaceId),
        isNotNull(pages.deletedAt),
        spaceNotArchived(page.spaceId),
      ),
    )
    .returning()
    .get();
  if (restored) return { ok: true, page: restored };
  return trashWriteFailure(db, page);
}

export type PurgeTrashedPageResult =
  | { ok: true }
  | {
      ok: false;
      error: "not_found" | "space_archived" | "not_in_trash" | "forbidden_role" | "forbidden_personal";
    };

// Deletes a page in the trash with its revisions (ON DELETE CASCADE). Admins only, and not for pages of
// personal spaces, which are left to the scheduled job: admins cannot see the personal spaces of others.
export async function purgeTrashedPage(db: Db, user: UserRow, pageId: string): Promise<PurgeTrashedPageResult> {
  // Also checked by requireAdmin in the REST API.
  if (user.role !== "admin") return { ok: false, error: "forbidden_role" };
  const found = await findAccessiblePageIncludingTrash(db, user, pageId);
  if (!found) return { ok: false, error: "not_found" };
  const { page, space } = found;
  // Only the owner can see a personal space here, so there is nothing to hide: forbidden rather than not_found.
  if (space.kind === "personal") return { ok: false, error: "forbidden_personal" };
  if (space.archivedAt !== null) return { ok: false, error: "space_archived" };
  if (page.deletedAt === null) return { ok: false, error: "not_in_trash" };
  // RETURNING rather than meta.changes, which in D1 also counts the revisions deleted in cascade.
  const deleted = await db
    .delete(pages)
    .where(
      and(
        eq(pages.id, page.id),
        eq(pages.spaceId, page.spaceId),
        isNotNull(pages.deletedAt),
        spaceNotArchived(page.spaceId),
      ),
    )
    .returning({ id: pages.id })
    .get();
  if (deleted) return { ok: true };
  return trashWriteFailure(db, page);
}

// Deletes the pages that have been in the trash for TRASH_RETENTION_MS or longer, with their revisions,
// and returns how many pages were deleted. Run daily by the scheduled handler, so a page is deleted
// 30 to 31 days after it was moved to the trash. One statement without a limit: the wiki is small.
export async function purgeExpiredTrash(db: Db, now: number): Promise<number> {
  // RETURNING rather than meta.changes, which in D1 also counts the revisions deleted in cascade.
  const deleted = await db
    .delete(pages)
    .where(and(isNotNull(pages.deletedAt), lte(pages.deletedAt, now - TRASH_RETENTION_MS)))
    .returning({ id: pages.id })
    .all();
  return deleted.length;
}
