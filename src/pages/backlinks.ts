import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { pages, spaces } from "../db/schema";
import { accessibleSpacesWhere, type SpaceViewer } from "../spaces/access";
import { findAccessiblePage, type PageSummaryRow } from "./queries";

export const BACKLINK_LIMIT = 50;

// Lists the pages that link to the page: any page whose body contains "/pages/{id}", as a relative link,
// a full URL or a longer path such as "/pages/{id}/history". There is no links table; the bodies are read
// on every call, so the cost grows with the number of pages the viewer can access.
// Known limitations: every occurrence counts, also inside code blocks, in URLs of other hosts and in
// "/api/v1/pages/{id}"; a body that mentions only the ID without "/pages/" is not a link; matching is
// case-sensitive. Page IDs are lower-case UUIDs of fixed length, so one ID is never a prefix of another.
// A target that is missing, in the trash or not accessible is reported as missing so that its existence
// is not revealed. Pages of archived spaces are left out, except those in the space of the target.
export async function listBacklinks(
  db: Db,
  viewer: SpaceViewer,
  pageId: string,
): Promise<{ ok: true; pages: PageSummaryRow[]; hasMore: boolean } | { ok: false; error: "not_found" }> {
  const target = await findAccessiblePage(db, viewer, pageId);
  if (!target) return { ok: false, error: "not_found" };
  // A subquery rather than bound IDs: D1 allows at most 100 bound parameters per statement.
  const access = inArray(
    pages.spaceId,
    db
      .select({ id: spaces.id })
      .from(spaces)
      .where(and(accessibleSpacesWhere(viewer), or(isNull(spaces.archivedAt), eq(spaces.id, target.spaceId)))),
  );
  // instr() rather than LIKE: "_" in a pattern is a wildcard, and D1 limits LIKE patterns to 50 bytes.
  const linksToTarget = sql`instr(${pages.body}, ${`/pages/${target.id}`}) > 0`;
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
    })
    .from(pages)
    .where(and(access, isNull(pages.deletedAt), ne(pages.id, target.id), linksToTarget))
    .orderBy(desc(pages.updatedAt), asc(pages.id))
    .limit(BACKLINK_LIMIT + 1)
    .all();
  return { ok: true, pages: rows.slice(0, BACKLINK_LIMIT), hasMore: rows.length > BACKLINK_LIMIT };
}
