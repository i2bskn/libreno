import { asc, eq } from "drizzle-orm";
import type { Db } from "@i2bskn/workers-app-core";
import { folders, type FolderRow, type SpaceRow } from "../db/schema";
import { findAccessibleSpace, type SpaceViewer } from "../spaces/access";

export function findFolderById(db: Db, id: string): Promise<FolderRow | undefined> {
  return db.select().from(folders).where(eq(folders.id, id)).get();
}

// Returns the folder with its space only if the viewer can access the space, otherwise null.
// Callers report null as missing so that the existence of the folder is not revealed.
export async function findAccessibleFolderWithSpace(
  db: Db,
  viewer: SpaceViewer,
  id: string,
): Promise<{ folder: FolderRow; space: SpaceRow } | null> {
  const folder = await findFolderById(db, id);
  if (!folder) return null;
  const space = await findAccessibleSpace(db, viewer, folder.spaceId);
  if (!space) return null;
  return { folder, space };
}

// Returns the folder only if the viewer can access its space, otherwise null.
// Callers report null as missing so that the existence of the folder is not revealed.
export async function findAccessibleFolder(db: Db, viewer: SpaceViewer, id: string): Promise<FolderRow | null> {
  const found = await findAccessibleFolderWithSpace(db, viewer, id);
  return found?.folder ?? null;
}

// Returns true if the folder exists in the space.
export async function folderExistsInSpace(db: Db, folderId: string, spaceId: string): Promise<boolean> {
  const folder = await findFolderById(db, folderId);
  return folder !== undefined && folder.spaceId === spaceId;
}

// All folders of the space as a flat list. Does not check access: callers check the space first.
// The order is a binary comparison of the names, then the ids.
export function listFolders(db: Db, spaceId: string): Promise<FolderRow[]> {
  return db
    .select()
    .from(folders)
    .where(eq(folders.spaceId, spaceId))
    .orderBy(asc(folders.name), asc(folders.id))
    .all();
}
