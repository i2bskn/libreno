import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@i2bskn/workers-app-core";
import { pages, type PageRow, type SpaceRow } from "../db/schema";
import { canAccessSpace, type SpaceViewer } from "../spaces/access";
import { findSpaceById } from "../spaces/queries";

// A page without its body and without the trash columns, as returned by page lists and search.
export type PageSummaryRow = Omit<PageRow, "body" | "deletedAt" | "deletedBy">;

// Includes pages in the trash (deleted_at is set). Use findAccessiblePage for pages that are not.
export function findPageById(db: Db, id: string): Promise<PageRow | undefined> {
  return db.select().from(pages).where(eq(pages.id, id)).get();
}

// Returns the page, including one in the trash, with its space only if the viewer can access the space,
// otherwise null. Callers report null as missing so that the existence of the page is not revealed.
export async function findAccessiblePageIncludingTrash(
  db: Db,
  viewer: SpaceViewer,
  id: string,
): Promise<{ page: PageRow; space: SpaceRow } | null> {
  const page = await findPageById(db, id);
  if (!page) return null;
  const space = await findSpaceById(db, page.spaceId);
  if (!space || !canAccessSpace(viewer, space)) return null;
  return { page, space };
}

// Returns the page only if it is not in the trash and the viewer can access its space, otherwise null.
// Callers report null as missing so that the existence of the page is not revealed.
export async function findAccessiblePage(db: Db, viewer: SpaceViewer, id: string): Promise<PageRow | null> {
  const found = await findAccessiblePageIncludingTrash(db, viewer, id);
  if (!found || found.page.deletedAt !== null) return null;
  return found.page;
}

// Lists the pages of the space that are not in the trash, without reading their bodies, which can be
// up to 512KB each.
export function listPageSummaries(db: Db, spaceId: string): Promise<PageSummaryRow[]> {
  return db
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
    })
    .from(pages)
    .where(and(eq(pages.spaceId, spaceId), isNull(pages.deletedAt)))
    .orderBy(desc(pages.updatedAt), asc(pages.id))
    .all();
}
