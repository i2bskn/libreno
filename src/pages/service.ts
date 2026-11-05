import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { CreatePageInput, MovePageInput, UpdatePageInput } from "../api/types";
import { clock, type Db } from "@i2bskn/workers-app-core";
import { isForeignKeyViolation } from "../db/errors";
import { folders, pages, spaces, type PageRow, type UserRow } from "../db/schema";
import { folderExistsInSpace } from "../folders/queries";
import {
  canAccessSpace,
  visibilityNotAcknowledged,
  type MoveOptions,
  type VisibilityNotAcknowledged,
} from "../spaces/access";
import { isSpaceArchived, spaceNotArchived } from "../spaces/archive";
import { findSpaceById } from "../spaces/queries";
import { findAccessiblePageIncludingTrash, findPageById } from "./queries";
import { insertRevisionQuery, pruneRevisionsQuery } from "./revisions";

// Shared by the REST API and the MCP tools. Input is validated by the callers (see validation.ts).

export type CreatePageResult =
  | { ok: true; page: PageRow }
  | { ok: false; error: "space_not_found" | "space_archived" | "folder_not_found" };

export async function createPage(
  db: Db,
  user: UserRow,
  spaceId: string,
  input: CreatePageInput,
): Promise<CreatePageResult> {
  const space = await findSpaceById(db, spaceId);
  // Spaces the user cannot access are reported as missing so that their existence is not revealed.
  if (!space || !canAccessSpace(user, space)) return { ok: false, error: "space_not_found" };
  // Checked after the access, so that whether a space the user cannot access is archived is not revealed.
  if (space.archivedAt !== null) return { ok: false, error: "space_archived" };
  if (input.folderId !== null && !(await folderExistsInSpace(db, input.folderId, space.id))) {
    return { ok: false, error: "folder_not_found" };
  }

  const now = clock.now();
  // One conditional INSERT ... SELECT, so that a folder moved to another space (or a space deleted or
  // archived) after the checks above inserts nothing. drizzle checks that the keys are those of the table,
  // in the same order.
  const conditions: SQL[] = [eq(spaces.id, space.id), isNull(spaces.archivedAt)];
  if (input.folderId !== null) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${folders} f WHERE f.id = ${input.folderId} AND f.space_id = ${space.id})`,
    );
  }
  let page: PageRow | undefined;
  try {
    page = await db
      .insert(pages)
      .select(
        db
          .select({
            id: sql<string>`${crypto.randomUUID()}`.as("id"),
            spaceId: sql<string>`${space.id}`.as("space_id"),
            folderId: sql<string | null>`${input.folderId}`.as("folder_id"),
            title: sql<string>`${input.title}`.as("title"),
            body: sql<string>`${input.body}`.as("body"),
            version: sql<number>`1`.as("version"),
            createdBy: sql<string>`${user.id}`.as("created_by"),
            updatedBy: sql<string>`${user.id}`.as("updated_by"),
            createdAt: sql<number>`${now}`.as("created_at"),
            updatedAt: sql<number>`${now}`.as("updated_at"),
            deletedAt: sql<number | null>`NULL`.as("deleted_at"),
            deletedBy: sql<string | null>`NULL`.as("deleted_by"),
          })
          .from(spaces)
          .where(and(...conditions)),
      )
      .returning()
      .get();
  } catch (error) {
    // The user was deleted after the checks above (the session ends with it).
    if (!isForeignKeyViolation(error)) throw error;
  }
  if (page) return { ok: true, page };
  // The folder was moved or deleted, or the space was deleted or archived, after the checks above.
  if (input.folderId !== null && !(await folderExistsInSpace(db, input.folderId, space.id))) {
    return { ok: false, error: "folder_not_found" };
  }
  if (await isSpaceArchived(db, space.id)) return { ok: false, error: "space_archived" };
  return { ok: false, error: "space_not_found" };
}

export type UpdatePageResult =
  | { ok: true; page: PageRow }
  | { ok: false; error: "not_found" | "space_archived" | "version_conflict" | "folder_not_found" };

// The condition of the UPDATE in updatePage and of the revision copied with it.
// space_id keeps the write inside the space whose access was checked, deleted_at keeps a page moved
// to the trash after the check from being updated, and the space must not be archived.
export function pageUpdateWhere(
  page: Pick<PageRow, "id" | "spaceId">,
  version: number,
  folderId: string | null | undefined,
): SQL | undefined {
  const conditions: SQL[] = [
    eq(pages.id, page.id),
    eq(pages.spaceId, page.spaceId),
    eq(pages.version, version),
    isNull(pages.deletedAt),
    spaceNotArchived(page.spaceId),
  ];
  if (typeof folderId === "string") {
    conditions.push(sql`EXISTS (SELECT 1 FROM ${folders} f WHERE f.id = ${folderId} AND f.space_id = ${page.spaceId})`);
  }
  return and(...conditions);
}

export async function updatePage(
  db: Db,
  user: UserRow,
  pageId: string,
  input: UpdatePageInput,
): Promise<UpdatePageResult> {
  const found = await findAccessiblePageIncludingTrash(db, user, pageId);
  if (!found || found.page.deletedAt !== null) return { ok: false, error: "not_found" };
  const { page } = found;
  if (found.space.archivedAt !== null) return { ok: false, error: "space_archived" };

  // The version is incremented even if nothing changed. Moving to another folder is an update too.
  const folderId = input.folderId;
  // The revision is copied with the same condition, so that it is kept only when the update happens.
  const where = pageUpdateWhere(page, input.version, folderId);
  const update = db
    .update(pages)
    .set({
      ...(input.title !== undefined && { title: input.title }),
      ...(input.body !== undefined && { body: input.body }),
      ...(folderId !== undefined && { folderId }),
      version: sql`${pages.version} + 1`,
      updatedBy: user.id,
      updatedAt: clock.now(),
    })
    .where(where)
    .returning();
  let updated: PageRow | undefined;
  if (input.title !== undefined || input.body !== undefined) {
    // One batch (a transaction in D1). The copy comes first so that it reads the values before the update.
    // Kept even if the values do not change. Moving to another folder alone keeps no revision.
    const [, rows] = await db.batch([insertRevisionQuery(db, where), update, pruneRevisionsQuery(db, page.id)]);
    updated = rows[0];
  } else {
    updated = await update.get();
  }
  if (updated) return { ok: true, page: updated };

  // Access is not checked again: the page was visible just before.
  const current = await findPageById(db, page.id);
  if (!current || current.spaceId !== page.spaceId || current.deletedAt !== null) {
    return { ok: false, error: "not_found" };
  }
  if (await isSpaceArchived(db, page.spaceId)) return { ok: false, error: "space_archived" };
  if (current.version !== input.version) return { ok: false, error: "version_conflict" };
  if (typeof folderId === "string") return { ok: false, error: "folder_not_found" };
  return { ok: false, error: "version_conflict" };
}

export type MovePageResult =
  | { ok: true; page: PageRow }
  | {
      ok: false;
      error: "not_found" | "space_not_found" | "space_archived" | "folder_not_found" | "version_conflict";
    }
  | VisibilityNotAcknowledged;

// The condition of the UPDATE in movePage. Like pageUpdateWhere, space_id keeps the write inside the space
// whose access was checked. The destination space and the folder in it must exist at the time of the write,
// and neither the source nor the destination space may be archived.
function pageMoveWhere(
  page: Pick<PageRow, "id" | "spaceId">,
  version: number,
  destSpaceId: string,
  folderId: string | null,
): SQL | undefined {
  const conditions: SQL[] = [
    eq(pages.id, page.id),
    eq(pages.spaceId, page.spaceId),
    eq(pages.version, version),
    isNull(pages.deletedAt),
    spaceNotArchived(page.spaceId),
    spaceNotArchived(destSpaceId),
  ];
  if (folderId !== null) {
    conditions.push(sql`EXISTS (SELECT 1 FROM ${folders} f WHERE f.id = ${folderId} AND f.space_id = ${destSpaceId})`);
  }
  return and(...conditions);
}

// Moves the page to a folder (or the top level, for null) of another space, or of the same space.
// The user needs access to both spaces. The revisions refer to the page, so they move with it; the title
// and body do not change, so no revision is kept, but the version is incremented.
export async function movePage(
  db: Db,
  user: UserRow,
  pageId: string,
  input: MovePageInput,
  options: MoveOptions,
): Promise<MovePageResult> {
  const found = await findAccessiblePageIncludingTrash(db, user, pageId);
  if (!found || found.page.deletedAt !== null) return { ok: false, error: "not_found" };
  const { page, space: source } = found;
  if (source.archivedAt !== null) return { ok: false, error: "space_archived" };
  const dest = await findSpaceById(db, input.spaceId);
  // Spaces the user cannot access are reported as missing so that their existence is not revealed.
  if (!dest || !canAccessSpace(user, dest)) return { ok: false, error: "space_not_found" };
  if (dest.archivedAt !== null) return { ok: false, error: "space_archived" };
  // Checked with the same source space as the condition of the write: if the page moves to another space
  // after this, the write changes nothing.
  const notAcknowledged = visibilityNotAcknowledged(source, dest, options);
  if (notAcknowledged) return notAcknowledged;

  let updated: PageRow | undefined;
  try {
    updated = await db
      .update(pages)
      .set({
        spaceId: dest.id,
        folderId: input.folderId,
        version: sql`${pages.version} + 1`,
        updatedBy: user.id,
        updatedAt: clock.now(),
      })
      .where(pageMoveWhere(page, input.version, dest.id, input.folderId))
      .returning()
      .get();
  } catch (error) {
    // The user was deleted after the checks above (the session ends with it). A backstop: the condition
    // already requires the destination space and folder.
    if (!isForeignKeyViolation(error)) throw error;
    return { ok: false, error: "space_not_found" };
  }
  if (updated) return { ok: true, page: updated };

  // Access is not checked again: the page and the destination space were visible just before.
  const current = await findPageById(db, page.id);
  if (!current || current.spaceId !== page.spaceId || current.deletedAt !== null) {
    return { ok: false, error: "not_found" };
  }
  if (await isSpaceArchived(db, page.spaceId)) return { ok: false, error: "space_archived" };
  const currentDest = await findSpaceById(db, dest.id);
  if (!currentDest) return { ok: false, error: "space_not_found" };
  if (currentDest.archivedAt !== null) return { ok: false, error: "space_archived" };
  if (current.version !== input.version) return { ok: false, error: "version_conflict" };
  if (input.folderId !== null) return { ok: false, error: "folder_not_found" };
  return { ok: false, error: "version_conflict" };
}
