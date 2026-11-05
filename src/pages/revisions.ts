import { and, desc, eq, notInArray, sql, type SQL } from "drizzle-orm";
import type { Db } from "@i2bskn/workers-app-core";
import { pageRevisions, pages, type PageRevisionRow, type PageRow, type UserRow } from "../db/schema";
import type { SpaceViewer } from "../spaces/access";
import { findAccessiblePage, findAccessiblePageIncludingTrash } from "./queries";
import { updatePage } from "./service";

// Shared by the REST API and the MCP tools. Reads check access to the page first, as in queries.ts.

// The number of earlier versions kept per page. Older revisions are deleted by the update that adds one.
export const PAGE_REVISION_LIMIT = 20;

// INSERT INTO page_revisions SELECT ... FROM pages WHERE <where>: copies the page as it is before the update.
// where must be the condition of the UPDATE that follows in the same batch, so that a revision is kept
// only when the update happens.
export function insertRevisionQuery(db: Db, where: SQL | undefined) {
  // drizzle checks that the keys are those of the table, in the same order.
  return db.insert(pageRevisions).select(
    db
      .select({
        id: sql<string>`${crypto.randomUUID()}`.as("id"),
        pageId: pages.id,
        version: pages.version,
        title: pages.title,
        body: pages.body,
        createdBy: pages.updatedBy,
        createdAt: pages.updatedAt,
      })
      .from(pages)
      .where(where),
  );
}

// Deletes the revisions of the page other than the newest PAGE_REVISION_LIMIT.
export function pruneRevisionsQuery(db: Db, pageId: string) {
  return db
    .delete(pageRevisions)
    .where(
      and(
        eq(pageRevisions.pageId, pageId),
        notInArray(
          pageRevisions.id,
          db
            .select({ id: pageRevisions.id })
            .from(pageRevisions)
            .where(eq(pageRevisions.pageId, pageId))
            .orderBy(desc(pageRevisions.version))
            .limit(PAGE_REVISION_LIMIT),
        ),
      ),
    );
}

export type RevisionSummaryRow = Pick<PageRevisionRow, "version" | "title" | "createdBy" | "createdAt">;

// Lists the revisions of a page, newest first, without reading their bodies.
export async function listAccessiblePageRevisions(
  db: Db,
  viewer: SpaceViewer,
  pageId: string,
): Promise<{ ok: true; revisions: RevisionSummaryRow[] } | { ok: false; error: "not_found" }> {
  const page = await findAccessiblePage(db, viewer, pageId);
  if (!page) return { ok: false, error: "not_found" };
  const revisions = await db
    .select({
      version: pageRevisions.version,
      title: pageRevisions.title,
      createdBy: pageRevisions.createdBy,
      createdAt: pageRevisions.createdAt,
    })
    .from(pageRevisions)
    .where(eq(pageRevisions.pageId, page.id))
    .orderBy(desc(pageRevisions.version))
    .all();
  return { ok: true, revisions };
}

export type FindPageRevisionResult =
  | { ok: true; revision: PageRevisionRow }
  | { ok: false; error: "not_found" | "revision_not_found" };

// version null is a version that cannot exist (an invalid one from the caller). It is reported as
// revision_not_found after the page is checked, so that a missing page is still not_found.
export async function findAccessiblePageRevision(
  db: Db,
  viewer: SpaceViewer,
  pageId: string,
  version: number | null,
): Promise<FindPageRevisionResult> {
  const page = await findAccessiblePage(db, viewer, pageId);
  if (!page) return { ok: false, error: "not_found" };
  if (version === null) return { ok: false, error: "revision_not_found" };
  const revision = await db
    .select()
    .from(pageRevisions)
    .where(and(eq(pageRevisions.pageId, page.id), eq(pageRevisions.version, version)))
    .get();
  if (!revision) return { ok: false, error: "revision_not_found" };
  return { ok: true, revision };
}

export type RestorePageRevisionResult =
  | { ok: true; page: PageRow }
  | { ok: false; error: "not_found" | "space_archived" | "revision_not_found" | "version_conflict" };

// Restoring is an ordinary update with the title and body of the revision: the current content is kept
// as a new revision and the version is incremented. The folder does not change.
// The title and body are written without validation again; they were valid when saved.
// The errors come in the order not_found, space_archived, revision_not_found, then those of the update.
export async function restorePageRevision(
  db: Db,
  user: UserRow,
  pageId: string,
  revisionVersion: number | null,
  currentVersion: number,
): Promise<RestorePageRevisionResult> {
  // Not in findAccessiblePageRevision, which the reads share: archived spaces can still be read.
  const page = await findAccessiblePageIncludingTrash(db, user, pageId);
  if (!page || page.page.deletedAt !== null) return { ok: false, error: "not_found" };
  if (page.space.archivedAt !== null) return { ok: false, error: "space_archived" };
  const found = await findAccessiblePageRevision(db, user, pageId, revisionVersion);
  if (!found.ok) return found;
  // The revision may be deleted from here on; its values are already read.
  const result = await updatePage(db, user, pageId, {
    version: currentVersion,
    title: found.revision.title,
    body: found.revision.body,
  });
  if (result.ok) return result;
  if (result.error === "folder_not_found") throw new Error("unreachable: restoring does not change the folder");
  return { ok: false, error: result.error };
}
