import { and, eq, exists, isNotNull, isNull, ne, sql, type SQL } from "drizzle-orm";
import type { CreateFolderInput, MoveFolderInput, UpdateFolderInput } from "../api/types";
import { clock, type Db } from "@i2bskn/workers-app-core";
import { isForeignKeyViolation } from "../db/errors";
import { folders, pages, spaces, type FolderRow, type UserRow } from "../db/schema";
import {
  findAccessibleSpace,
  visibilityNotAcknowledged,
  type MoveOptions,
  type VisibilityNotAcknowledged,
} from "../spaces/access";
import { isSpaceArchived, spaceNotArchived } from "../spaces/archive";
import { findSpaceById } from "../spaces/queries";
import { findAccessibleFolderWithSpace, findFolderById, folderExistsInSpace } from "./queries";

// Shared by the REST API and the MCP tools. Input is validated by the callers (see validation.ts).
// D1 has no interactive transactions, so each write is one conditional statement.

export type CreateFolderResult =
  | { ok: true; folder: FolderRow }
  | { ok: false; error: "space_not_found" | "space_archived" | "parent_not_found" };

export async function createFolder(
  db: Db,
  user: UserRow,
  spaceId: string,
  input: CreateFolderInput,
): Promise<CreateFolderResult> {
  const space = await findAccessibleSpace(db, user, spaceId);
  // Spaces the user cannot access are reported as missing so that their existence is not revealed.
  if (!space) return { ok: false, error: "space_not_found" };
  // Checked after the access, so that whether a space the user cannot access is archived is not revealed.
  if (space.archivedAt !== null) return { ok: false, error: "space_archived" };
  if (input.parentId !== null && !(await folderExistsInSpace(db, input.parentId, space.id))) {
    return { ok: false, error: "parent_not_found" };
  }

  const now = clock.now();
  // One conditional INSERT ... SELECT, so that a parent moved to another space (or a space deleted or
  // archived) after the checks above inserts nothing. drizzle checks that the keys are those of the table,
  // in the same order.
  const conditions: SQL[] = [eq(spaces.id, space.id), isNull(spaces.archivedAt)];
  if (input.parentId !== null) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${folders} p WHERE p.id = ${input.parentId} AND p.space_id = ${space.id})`,
    );
  }
  let folder: FolderRow | undefined;
  try {
    folder = await db
      .insert(folders)
      .select(
        db
          .select({
            id: sql<string>`${crypto.randomUUID()}`.as("id"),
            spaceId: sql<string>`${space.id}`.as("space_id"),
            parentId: sql<string | null>`${input.parentId}`.as("parent_id"),
            name: sql<string>`${input.name}`.as("name"),
            createdBy: sql<string>`${user.id}`.as("created_by"),
            updatedBy: sql<string>`${user.id}`.as("updated_by"),
            createdAt: sql<number>`${now}`.as("created_at"),
            updatedAt: sql<number>`${now}`.as("updated_at"),
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
  if (folder) return { ok: true, folder };
  // The parent was moved or deleted, or the space was deleted or archived, after the checks above.
  if (input.parentId !== null && !(await folderExistsInSpace(db, input.parentId, space.id))) {
    return { ok: false, error: "parent_not_found" };
  }
  if (await isSpaceArchived(db, space.id)) return { ok: false, error: "space_archived" };
  return { ok: false, error: "space_not_found" };
}

export type UpdateFolderResult =
  | { ok: true; folder: FolderRow }
  | { ok: false; error: "not_found" | "space_archived" | "parent_not_found" | "folder_cycle" };

// Renames the folder and/or moves it inside its space. No version: the last write wins.
export async function updateFolder(
  db: Db,
  user: UserRow,
  folderId: string,
  input: UpdateFolderInput,
): Promise<UpdateFolderResult> {
  const found = await findAccessibleFolderWithSpace(db, user, folderId);
  if (!found) return { ok: false, error: "not_found" };
  const { folder } = found;
  if (found.space.archivedAt !== null) return { ok: false, error: "space_archived" };

  // space_id keeps the write inside the space whose access was just checked, and the space must not be
  // archived at the time of the write.
  const conditions: SQL[] = [
    eq(folders.id, folder.id),
    eq(folders.spaceId, folder.spaceId),
    spaceNotArchived(folder.spaceId),
  ];
  const parentId = input.parentId;
  if (typeof parentId === "string") {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${folders} p WHERE p.id = ${parentId} AND p.space_id = ${folder.spaceId})`,
      // Walks up from the new parent; finding the folder itself means a cycle. This also rejects the folder
      // as its own parent. UNION (not UNION ALL) stops even on an existing cycle.
      // D1 runs writes one at a time, so two concurrent moves cannot make a cycle either.
      sql`NOT EXISTS (WITH RECURSIVE anc(id) AS (
        SELECT ${parentId}
        UNION SELECT f.parent_id FROM ${folders} f JOIN anc ON f.id = anc.id WHERE f.parent_id IS NOT NULL
      ) SELECT 1 FROM anc WHERE anc.id = ${folder.id})`,
    );
  }
  // Updated even if nothing changed, so that updated_at and updated_by move forward.
  const updated = await db
    .update(folders)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(parentId !== undefined && { parentId }),
      updatedBy: user.id,
      updatedAt: clock.now(),
    })
    .where(and(...conditions))
    .returning()
    .get();
  if (updated) return { ok: true, folder: updated };

  // Access is not checked again: the folder was visible just before.
  const current = await findFolderById(db, folder.id);
  if (!current || current.spaceId !== folder.spaceId) return { ok: false, error: "not_found" };
  if (await isSpaceArchived(db, folder.spaceId)) return { ok: false, error: "space_archived" };
  if (typeof parentId === "string" && !(await folderExistsInSpace(db, parentId, folder.spaceId))) {
    return { ok: false, error: "parent_not_found" };
  }
  return { ok: false, error: "folder_cycle" };
}

export type DeleteFolderResult =
  | { ok: true }
  | { ok: false; error: "not_found" | "space_archived" | "folder_not_empty" };

// The condition on folders for deleting the folder: it has no folders and no pages outside the trash in it,
// and its space is not archived. Shared by the statements of deleteFolder so that they cannot disagree.
function deletableFolderWhere(folder: Pick<FolderRow, "id" | "spaceId">): SQL | undefined {
  return and(
    eq(folders.id, folder.id),
    eq(folders.spaceId, folder.spaceId),
    spaceNotArchived(folder.spaceId),
    sql`NOT EXISTS (SELECT 1 FROM ${folders} c WHERE c.parent_id = ${folder.id})`,
    sql`NOT EXISTS (SELECT 1 FROM ${pages} WHERE ${pages.folderId} = ${folder.id} AND ${pages.deletedAt} IS NULL)`,
  );
}

// Deletes the folder only if it has no folders or pages (other than pages in the trash) in it.
// Pages in the trash of the folder move to the top level of the space.
export async function deleteFolder(db: Db, user: UserRow, folderId: string): Promise<DeleteFolderResult> {
  const found = await findAccessibleFolderWithSpace(db, user, folderId);
  if (!found) return { ok: false, error: "not_found" };
  const { folder } = found;
  if (found.space.archivedAt !== null) return { ok: false, error: "space_archived" };

  // One batch (a transaction in D1) with the same condition in both statements, so a folder or page added
  // after the check above keeps the folder and the pages in the trash where they are.
  // The pages in the trash are moved first; the foreign keys from folders.parent_id and pages.folder_id
  // also reject the delete.
  const where = deletableFolderWhere(folder);
  const [, result] = await db.batch([
    db
      .update(pages)
      .set({ folderId: null })
      .where(
        and(
          eq(pages.folderId, folder.id),
          isNotNull(pages.deletedAt),
          exists(db.select({ one: sql`1` }).from(folders).where(where)),
        ),
      ),
    db.delete(folders).where(where),
  ]);
  if (result.meta.changes === 1) return { ok: true };
  const current = await findFolderById(db, folder.id);
  if (!current || current.spaceId !== folder.spaceId) return { ok: false, error: "not_found" };
  if (await isSpaceArchived(db, folder.spaceId)) return { ok: false, error: "space_archived" };
  return { ok: false, error: "folder_not_empty" };
}

export type MoveFolderResult =
  | { ok: true; folder: FolderRow }
  | {
      ok: false;
      error: "not_found" | "space_not_found" | "space_archived" | "parent_not_found" | "folder_cycle";
    }
  | VisibilityNotAcknowledged;

// The ids of the folder and the folders inside it, at any depth, as a subquery. UNION (not UNION ALL)
// stops even on an existing cycle.
function subtreeIds(rootId: string): SQL {
  return sql`WITH RECURSIVE sub(id) AS (
    SELECT ${rootId}
    UNION SELECT f.id FROM ${folders} f JOIN sub ON f.parent_id = sub.id
  ) SELECT id FROM sub`;
}

// The condition shared by the statements of moveFolder, so that they all change rows or none do.
// It stays the same through the batch:
// - It does not depend on pages, so the first statement (on pages) cannot change it.
// - The second statement changes the space of the folders inside the root, but not the root, so "the root
//   is in the source space" holds until the third statement; no parent_id changes before the third
//   statement, so the subtree and "the parent is not in the subtree" do not change either.
// - "The parent is in the destination space" could change only if the parent were in the subtree, which
//   the condition rules out.
// - No statement changes archived_at, so "neither space is archived" does not change either.
function folderMoveGuard(
  folder: Pick<FolderRow, "id" | "spaceId">,
  destSpaceId: string,
  parentId: string | null,
): SQL | undefined {
  const conditions: SQL[] = [
    sql`EXISTS (SELECT 1 FROM ${folders} r WHERE r.id = ${folder.id} AND r.space_id = ${folder.spaceId})`,
    spaceNotArchived(folder.spaceId),
    spaceNotArchived(destSpaceId),
  ];
  if (parentId !== null) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${folders} p WHERE p.id = ${parentId} AND p.space_id = ${destSpaceId})`,
      // The folder itself and the folders inside it cannot be its parent.
      sql`${parentId} NOT IN (${subtreeIds(folder.id)})`,
    );
  }
  return and(...conditions);
}

// Moves the folder into a folder (or the top level, for null) of another space, or of the same space.
// The folders and pages inside it, including pages in the trash, move with it and keep their place in it.
// The user needs access to both spaces. Only the folder itself gets a new updated_at and updated_by.
export async function moveFolder(
  db: Db,
  user: UserRow,
  folderId: string,
  input: MoveFolderInput,
  options: MoveOptions,
): Promise<MoveFolderResult> {
  const found = await findAccessibleFolderWithSpace(db, user, folderId);
  if (!found) return { ok: false, error: "not_found" };
  const { folder, space: source } = found;
  if (source.archivedAt !== null) return { ok: false, error: "space_archived" };
  const dest = await findAccessibleSpace(db, user, input.spaceId);
  // Spaces the user cannot access are reported as missing so that their existence is not revealed.
  if (!dest) return { ok: false, error: "space_not_found" };
  if (dest.archivedAt !== null) return { ok: false, error: "space_archived" };
  // Checked with the same source space as the condition of the writes: if the folder moves to another
  // space after this, the writes change nothing.
  const notAcknowledged = visibilityNotAcknowledged(source, dest, options);
  if (notAcknowledged) return notAcknowledged;

  // One batch (a transaction in D1) with the same guard in all statements, so that the contents are never
  // split between two spaces. The pages and the folders inside are moved before the folder itself, while
  // the guard can still see the folder in the source space.
  const guard = folderMoveGuard(folder, dest.id, input.parentId);
  const subtree = subtreeIds(folder.id);
  let moved: FolderRow | undefined;
  try {
    const [, , rows] = await db.batch([
      // Including pages in the trash. Their version and updated_at do not change.
      db
        .update(pages)
        .set({ spaceId: dest.id })
        .where(and(eq(pages.spaceId, folder.spaceId), sql`${pages.folderId} IN (${subtree})`, guard)),
      // The folders inside keep their parents and updated_at.
      db
        .update(folders)
        .set({ spaceId: dest.id })
        .where(
          and(
            eq(folders.spaceId, folder.spaceId),
            sql`${folders.id} IN (${subtree})`,
            ne(folders.id, folder.id),
            guard,
          ),
        ),
      db
        .update(folders)
        .set({ spaceId: dest.id, parentId: input.parentId, updatedBy: user.id, updatedAt: clock.now() })
        .where(and(eq(folders.id, folder.id), guard))
        .returning(),
    ]);
    moved = rows[0];
  } catch (error) {
    // The user was deleted after the checks above (the session ends with it). A backstop: the guard
    // already requires the destination space and parent.
    if (!isForeignKeyViolation(error)) throw error;
    return { ok: false, error: "space_not_found" };
  }
  if (moved) return { ok: true, folder: moved };

  // Access is not checked again: the folder and the destination space were visible just before.
  const current = await findFolderById(db, folder.id);
  if (!current || current.spaceId !== folder.spaceId) return { ok: false, error: "not_found" };
  if (await isSpaceArchived(db, folder.spaceId)) return { ok: false, error: "space_archived" };
  const currentDest = await findSpaceById(db, dest.id);
  if (!currentDest) return { ok: false, error: "space_not_found" };
  if (currentDest.archivedAt !== null) return { ok: false, error: "space_archived" };
  if (input.parentId !== null) {
    if (!(await folderExistsInSpace(db, input.parentId, dest.id))) return { ok: false, error: "parent_not_found" };
    return { ok: false, error: "folder_cycle" };
  }
  return { ok: false, error: "not_found" };
}
