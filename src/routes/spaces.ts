import { Hono } from "hono";
import { and, eq, ne, sql } from "drizzle-orm";
import type {
  CreateSpaceInput,
  CreateSpaceRequest,
  FolderList,
  PageList,
  SpaceList,
  TrashList,
  UpdateSpaceInput,
  UpdateSpaceRequest,
} from "../api/types";
import { clock } from "../clock";
import { folders, pages, spaces } from "../db/schema";
import type { AppEnv } from "../env";
import { apiError, requireAdmin, requireUser } from "../auth/middleware";
import { isUniqueViolation } from "../auth/users";
import { listFolders } from "../folders/queries";
import { createFolder } from "../folders/service";
import { folderNotFoundMessage, parentNotFoundOnCreateMessage } from "../folders/validation";
import { listPageSummaries } from "../pages/queries";
import { createPage } from "../pages/service";
import { listTrash } from "../pages/trash";
import { accessibleSpacesWhere, canAccessSpace } from "../spaces/access";
import { findSpaceById, spaceListOrder } from "../spaces/queries";
import { jsonBody, toApiFolder, toApiPage, toApiPageSummary, toApiSpace, toApiTrashedPage } from "./api";
import { createFolderBody } from "./folders";
import { createPageBody } from "./pages";

const SPACE_NAME_MAX_LENGTH = 100;
const SPACE_SORT_ORDER_MIN = -1000000;
const SPACE_SORT_ORDER_MAX = 1000000;
const CONTROL_CHARACTER = /\p{Cc}/u;

const spaceNotFound = "スペースが見つかりません";
const invalidName = "スペースの名前は 1 文字以上 100 文字以下で、改行を含まない文字列にしてください";
const nameTaken = "この名前のスペースはすでにあります";
const emptySpaceUpdate = "変更する項目（name か sort_order）を指定してください";
const invalidSortOrder = "表示順は -1000000 以上 1000000 以下の整数にしてください";

// Returns the trimmed name, or null if invalid. Length is counted in code points; no Unicode normalization.
function normalizeSpaceName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  const length = [...name].length;
  if (length < 1 || length > SPACE_NAME_MAX_LENGTH || CONTROL_CHARACTER.test(name)) return null;
  return name;
}

function isValidSortOrder(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= SPACE_SORT_ORDER_MIN &&
    value <= SPACE_SORT_ORDER_MAX
  );
}

function isCreatableKind(value: unknown): value is CreateSpaceInput["kind"] {
  return value === "everyone" || value === "admin";
}

const createSpaceBody = jsonBody<CreateSpaceRequest, CreateSpaceInput>((body, c) => {
  if (!isCreatableKind(body.kind)) {
    return apiError(c, 400, "invalid_kind", "スペースの種類は everyone または admin です");
  }
  const name = normalizeSpaceName(body.name);
  if (name === null) return apiError(c, 400, "invalid_name", invalidName);
  return { ok: true, value: { kind: body.kind, name } };
});

// Validated in the order name, sort_order.
const updateSpaceBody = jsonBody<UpdateSpaceRequest, UpdateSpaceInput>((body, c) => {
  if (body.name === undefined && body.sort_order === undefined) {
    return apiError(c, 400, "empty_update", emptySpaceUpdate);
  }
  const value: UpdateSpaceInput = {};
  if (body.name !== undefined) {
    const name = normalizeSpaceName(body.name);
    if (name === null) return apiError(c, 400, "invalid_name", invalidName);
    value.name = name;
  }
  if (body.sort_order !== undefined) {
    if (!isValidSortOrder(body.sort_order)) return apiError(c, 400, "invalid_sort_order", invalidSortOrder);
    value.sortOrder = body.sort_order;
  }
  return { ok: true, value };
});

const spacesApi = new Hono<AppEnv>()
  .get("/", requireUser, async (c) => {
    const rows = await c
      .get("db")
      .select()
      .from(spaces)
      .where(accessibleSpacesWhere(c.get("user")))
      .orderBy(...spaceListOrder)
      .all();
    const body: SpaceList = { spaces: rows.map(toApiSpace) };
    return c.json(body, 200);
  })
  .get("/:id", requireUser, async (c) => {
    const space = await findSpaceById(c.get("db"), c.req.param("id"));
    // Spaces the user cannot access are reported as missing so that their existence is not revealed.
    if (!space || !canAccessSpace(c.get("user"), space)) return apiError(c, 404, "not_found", spaceNotFound);
    return c.json(toApiSpace(space), 200);
  })
  .post("/", requireUser, requireAdmin, createSpaceBody, async (c) => {
    const input = c.req.valid("json");
    const now = clock.now();
    let created;
    try {
      created = await c
        .get("db")
        .insert(spaces)
        .values({ id: crypto.randomUUID(), kind: input.kind, name: input.name, createdAt: now, updatedAt: now })
        .returning()
        .get();
    } catch (error) {
      if (isUniqueViolation(error)) return apiError(c, 409, "name_taken", nameTaken);
      throw error;
    }
    return c.json(toApiSpace(created), 201);
  })
  .patch("/:id", requireUser, requireAdmin, updateSpaceBody, async (c) => {
    const input = c.req.valid("json");
    const db = c.get("db");
    const space = await findSpaceById(db, c.req.param("id"));
    if (!space || !canAccessSpace(c.get("user"), space)) return apiError(c, 404, "not_found", spaceNotFound);
    // Only the owner can see a personal space here, so there is nothing to hide: 403 rather than 404.
    if (space.kind === "personal") {
      return apiError(c, 403, "forbidden", "個人スペースは変更できません");
    }
    const changes: { name?: string; sortOrder?: number } = {};
    if (input.name !== undefined && input.name !== space.name) changes.name = input.name;
    if (input.sortOrder !== undefined && input.sortOrder !== space.sortOrder) changes.sortOrder = input.sortOrder;
    if (Object.keys(changes).length === 0) return c.json(toApiSpace(space), 200);

    let updated;
    try {
      updated = await db
        .update(spaces)
        .set({ ...changes, updatedAt: clock.now() })
        .where(eq(spaces.id, space.id))
        .returning()
        .get();
    } catch (error) {
      if (isUniqueViolation(error)) return apiError(c, 409, "name_taken", nameTaken);
      throw error;
    }
    if (!updated) return apiError(c, 404, "not_found", spaceNotFound);
    return c.json(toApiSpace(updated), 200);
  })
  .delete("/:id", requireUser, requireAdmin, async (c) => {
    const db = c.get("db");
    const space = await findSpaceById(db, c.req.param("id"));
    if (!space || !canAccessSpace(c.get("user"), space)) return apiError(c, 404, "not_found", spaceNotFound);
    // Only the owner can see a personal space here, so there is nothing to hide: 403 rather than 404.
    if (space.kind === "personal") return apiError(c, 403, "forbidden", "個人スペースは削除できません");

    // One statement, so a page or folder created after the check above keeps the space.
    // Pages in the trash count too: they still belong to the space.
    // The foreign keys from pages.space_id and folders.space_id also reject the delete.
    const result = await db
      .delete(spaces)
      .where(
        and(
          eq(spaces.id, space.id),
          ne(spaces.kind, "personal"),
          sql`NOT EXISTS (SELECT 1 FROM ${pages} WHERE ${pages.spaceId} = ${space.id})`,
          sql`NOT EXISTS (SELECT 1 FROM ${folders} WHERE ${folders.spaceId} = ${space.id})`,
        ),
      )
      .run();
    if (result.meta.changes === 1) return c.body(null, 204);
    if (!(await findSpaceById(db, space.id))) return apiError(c, 404, "not_found", spaceNotFound);
    return apiError(
      c,
      409,
      "space_not_empty",
      "ページ（ゴミ箱のページを含む）かフォルダが残っているスペースは削除できません。中身を移すか削除してから消してください",
    );
  })
  .get("/:id/pages", requireUser, async (c) => {
    const db = c.get("db");
    const space = await findSpaceById(db, c.req.param("id"));
    if (!space || !canAccessSpace(c.get("user"), space)) return apiError(c, 404, "not_found", spaceNotFound);
    const rows = await listPageSummaries(db, space.id);
    const body: PageList = { pages: rows.map(toApiPageSummary) };
    return c.json(body, 200);
  })
  .post("/:id/pages", requireUser, createPageBody, async (c) => {
    const result = await createPage(c.get("db"), c.get("user"), c.req.param("id"), c.req.valid("json"));
    if (result.ok) return c.json(toApiPage(result.page), 201);
    // 400 rather than 404: the space in the path exists, but the folder in the body does not.
    if (result.error === "folder_not_found") return apiError(c, 400, "folder_not_found", folderNotFoundMessage);
    return apiError(c, 404, "not_found", spaceNotFound);
  })
  .get("/:id/trash", requireUser, async (c) => {
    const result = await listTrash(c.get("db"), c.get("user"), c.req.param("id"));
    if (!result.ok) return apiError(c, 404, "not_found", spaceNotFound);
    const body: TrashList = { pages: result.pages.map(toApiTrashedPage) };
    return c.json(body, 200);
  })
  .get("/:id/folders", requireUser, async (c) => {
    const db = c.get("db");
    const space = await findSpaceById(db, c.req.param("id"));
    if (!space || !canAccessSpace(c.get("user"), space)) return apiError(c, 404, "not_found", spaceNotFound);
    const rows = await listFolders(db, space.id);
    const body: FolderList = { folders: rows.map(toApiFolder) };
    return c.json(body, 200);
  })
  .post("/:id/folders", requireUser, createFolderBody, async (c) => {
    const result = await createFolder(c.get("db"), c.get("user"), c.req.param("id"), c.req.valid("json"));
    if (result.ok) return c.json(toApiFolder(result.folder), 201);
    // 400 rather than 404: the space in the path exists, but the parent in the body does not.
    if (result.error === "parent_not_found") {
      return apiError(c, 400, "parent_not_found", parentNotFoundOnCreateMessage);
    }
    return apiError(c, 404, "not_found", spaceNotFound);
  });

export default spacesApi;
