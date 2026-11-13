import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@i2bskn/workers-app-core";
import { pages, spaces } from "../db/schema";
import { accessibleSpacesWhere, findAccessibleSpace, type SpaceViewer } from "../spaces/access";
import type { PageSummaryRow } from "./queries";

export const SEARCH_LIMIT = 50;
// Characters before and after the first match in a snippet.
const SNIPPET_CONTEXT = 40;

export type SearchHitRow = PageSummaryRow & { snippet: string | null };
export type SearchPagesResult = { hits: SearchHitRow[]; hasMore: boolean };

// Matching uses instr() rather than LIKE: D1 limits LIKE patterns to 50 bytes, shorter than a
// 100-character query. lower() folds ASCII letters only (no ICU), so only those match case-insensitively.
// Kept in one function so that it can be replaced by a full-text index later.
// query must be normalized by normalizeSearchQuery; spaceId must be a space the viewer can access.
// Without spaceId, archived spaces are left out; with it, the space is searched even if it is archived.
export async function searchPages(
  db: Db,
  viewer: SpaceViewer,
  query: string,
  spaceId?: string,
): Promise<SearchPagesResult> {
  // instr() has no wildcards, so the query needs no escaping.
  const titleMatch = sql`instr(lower(${pages.title}), lower(${query})) > 0`;
  const bodyMatch = sql`instr(lower(${pages.body}), lower(${query})) > 0`;
  // A subquery rather than bound IDs: D1 allows at most 100 bound parameters per statement.
  const access = inArray(
    pages.spaceId,
    db
      .select({ id: spaces.id })
      .from(spaces)
      .where(and(accessibleSpacesWhere(viewer), spaceId === undefined ? isNull(spaces.archivedAt) : undefined)),
  );
  // or() wraps the matches in parentheses; and() does not wrap its conditions, so a bare
  // "title match OR body match" would leak body matches from other spaces.
  const where = and(
    access,
    spaceId === undefined ? undefined : eq(pages.spaceId, spaceId),
    // Pages in the trash are not searched.
    isNull(pages.deletedAt),
    or(titleMatch, bodyMatch),
  );
  // instr, substr and length count characters on TEXT.
  const position = sql`instr(lower(${pages.body}), lower(${query}))`;
  const snippet = sql<string | null>`CASE WHEN ${position} > 0
    THEN substr(${pages.body}, max(1, ${position} - ${SNIPPET_CONTEXT}), ${SNIPPET_CONTEXT * 2} + length(${query}))
    ELSE NULL END`.as("snippet");

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
      snippet,
    })
    .from(pages)
    .where(where)
    // Title matches first, then the most recently updated.
    .orderBy(sql`(${titleMatch}) DESC`, desc(pages.updatedAt), asc(pages.id))
    .limit(SEARCH_LIMIT + 1)
    .all();
  return { hits: rows.slice(0, SEARCH_LIMIT), hasMore: rows.length > SEARCH_LIMIT };
}

// Used by the REST API and the MCP tool. An empty spaceId searches all accessible spaces.
// Spaces the viewer cannot access are reported as missing so that their existence is not revealed.
export async function searchAccessiblePages(
  db: Db,
  viewer: SpaceViewer,
  query: string,
  spaceId?: string,
): Promise<{ ok: true; result: SearchPagesResult } | { ok: false; error: "space_not_found" }> {
  if (spaceId === undefined || spaceId === "") {
    return { ok: true, result: await searchPages(db, viewer, query) };
  }
  const space = await findAccessibleSpace(db, viewer, spaceId);
  if (!space) return { ok: false, error: "space_not_found" };
  return { ok: true, result: await searchPages(db, viewer, query, space.id) };
}
