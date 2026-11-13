import { Hono, type Context, type MiddlewareHandler } from "hono";
import { and, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type {
  CreateSpaceInput,
  CreateSpaceRequest,
  FolderList,
  PageList,
  SetSpaceMembersRequest,
  SpaceList,
  SpaceMembers,
  TrashList,
  UpdateSpaceInput,
  UpdateSpaceRequest,
} from "../api/types";
import { apiError, clock, isUniqueViolation } from "@i2bskn/workers-app-core";
import { isSpaceUniqueViolation } from "../db/errors";
import { folders, pages, spaces } from "../db/schema";
import type { AppEnv } from "../env";
import { core } from "../core";
import { listFolders } from "../folders/queries";
import { createFolder } from "../folders/service";
import { folderNotFoundMessage, parentNotFoundOnCreateMessage } from "../folders/validation";
import { listPageSummaries } from "../pages/queries";
import { createPage } from "../pages/service";
import { listTrash } from "../pages/trash";
import { accessibleSpacesWhere, findAccessibleSpace } from "../spaces/access";
import { setSpaceArchived, spaceArchivedMessage } from "../spaces/archive";
import {
  countExistingUsers,
  deleteSpaceMembersStatement,
  findSpaceById,
  insertSpaceMembersStatement,
  listSpaceMemberIds,
  spaceListOrder,
} from "../spaces/queries";
import { jsonBody, toApiFolder, toApiPage, toApiPageSummary, toApiSpace, toApiTrashedPage } from "./api";
import { createFolderBody } from "./folders";
import { createPageBody } from "./pages";

const { requireAdmin, requireUser } = core.middleware;

const SPACE_NAME_MAX_LENGTH = 100;
const SPACE_SORT_ORDER_MIN = -1000000;
const SPACE_SORT_ORDER_MAX = 1000000;
const CONTROL_CHARACTER = /\p{Cc}/u;
const MEMBER_ID_MAX_LENGTH = 100;
const SPACE_MEMBERS_MAX = 500;

const spaceNotFound = "スペースが見つかりません";
const invalidName = "スペースの名前は 1 文字以上 100 文字以下で、改行を含まない文字列にしてください";
const nameTaken = "この名前のスペースはすでにあります（アーカイブされたスペースを含みます）";
const archivePersonalForbidden = "個人スペースはアーカイブできません";
const emptySpaceUpdate = "変更する項目（name か sort_order）を指定してください";
const invalidSortOrder = "表示順は -1000000 以上 1000000 以下の整数にしてください";
const invalidMemberIds = "メンバーの指定が正しくありません";
const tooManyMembers = "メンバーは500人まで指定できます";
const memberNotFound = "存在しないユーザーが含まれています。画面を読み込み直してください";
const notMembersSpace = "メンバー指定のスペースではありません";

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
  return value === "everyone" || value === "admin" || value === "members";
}

// Checks the shape of a list of member IDs and removes duplicates, keeping the first of each. Whether the users
// exist is checked by the handlers against the DB. Shared by the creation of a space and PUT /:id/members.
function normalizeMemberIds(
  value: unknown,
): { ok: true; ids: string[] } | { ok: false; error: "invalid_member_ids" | "too_many_members" } {
  if (!Array.isArray(value)) return { ok: false, error: "invalid_member_ids" };
  const ids = new Set<string>();
  for (const id of value) {
    if (typeof id !== "string") return { ok: false, error: "invalid_member_ids" };
    const length = [...id].length;
    if (length < 1 || length > MEMBER_ID_MAX_LENGTH) return { ok: false, error: "invalid_member_ids" };
    ids.add(id);
  }
  if (ids.size > SPACE_MEMBERS_MAX) return { ok: false, error: "too_many_members" };
  return { ok: true, ids: [...ids] };
}

function memberIdsError(c: Context<AppEnv>, error: "invalid_member_ids" | "too_many_members") {
  if (error === "too_many_members") return apiError(c, 400, "too_many_members", tooManyMembers);
  return apiError(c, 400, "invalid_member_ids", invalidMemberIds);
}

// Validated in the order kind, name, member_ids.
const createSpaceBody = jsonBody<CreateSpaceRequest, CreateSpaceInput, AppEnv>((body, c) => {
  if (!isCreatableKind(body.kind)) {
    return apiError(c, 400, "invalid_kind", "スペースの種類は everyone・admin・members のいずれかです");
  }
  const name = normalizeSpaceName(body.name);
  if (name === null) return apiError(c, 400, "invalid_name", invalidName);
  if (body.kind !== "members") {
    // Members belong to members spaces only; any member_ids (null included) with another kind is a mistake.
    if (body.member_ids !== undefined) return apiError(c, 400, "invalid_member_ids", invalidMemberIds);
    return { ok: true, value: { kind: body.kind, name, memberIds: [] } };
  }
  if (body.member_ids === undefined) return { ok: true, value: { kind: body.kind, name, memberIds: [] } };
  const memberIds = normalizeMemberIds(body.member_ids);
  if (!memberIds.ok) return memberIdsError(c, memberIds.error);
  return { ok: true, value: { kind: body.kind, name, memberIds: memberIds.ids } };
});

const setSpaceMembersBody = jsonBody<SetSpaceMembersRequest, { userIds: string[] }, AppEnv>((body, c) => {
  const userIds = normalizeMemberIds(body.user_ids);
  if (!userIds.ok) return memberIdsError(c, userIds.error);
  return { ok: true, value: { userIds: userIds.ids } };
});

// Validated in the order name, sort_order.
const updateSpaceBody = jsonBody<UpdateSpaceRequest, UpdateSpaceInput, AppEnv>((body, c) => {
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

// ?archived=true lists the archived spaces only; any other value (or none) lists the others.
// Not validator("query"), which turns repeated keys into arrays; c.req.query() takes the first value.
const spaceListQuery: MiddlewareHandler<
  AppEnv,
  string,
  { in: { query: { archived?: string } }; out: { query: { archived: boolean } } }
> = async (c, next) => {
  c.req.addValidatedData("query", { archived: c.req.query("archived") === "true" });
  return next();
};

const spacesApi = new Hono<AppEnv>()
  .get("/", requireUser, spaceListQuery, async (c) => {
    const { archived } = c.req.valid("query");
    const rows = await c
      .get("db")
      .select()
      .from(spaces)
      .where(
        and(
          accessibleSpacesWhere(c.get("user")),
          archived ? isNotNull(spaces.archivedAt) : isNull(spaces.archivedAt),
        ),
      )
      .orderBy(...spaceListOrder)
      .all();
    const body: SpaceList = { spaces: rows.map(toApiSpace) };
    return c.json(body, 200);
  })
  .get("/:id", requireUser, async (c) => {
    const space = await findAccessibleSpace(c.get("db"), c.get("user"), c.req.param("id"));
    // Spaces the user cannot access are reported as missing so that their existence is not revealed.
    if (!space) return apiError(c, 404, "not_found", spaceNotFound);
    return c.json(toApiSpace(space), 200);
  })
  .post("/:id/archive", requireUser, requireAdmin, async (c) => {
    const result = await setSpaceArchived(c.get("db"), c.get("user"), c.req.param("id"), true);
    if (result.ok) return c.json(toApiSpace(result.space), 200);
    if (result.error === "forbidden_personal") return apiError(c, 403, "forbidden", archivePersonalForbidden);
    return apiError(c, 404, "not_found", spaceNotFound);
  })
  .post("/:id/unarchive", requireUser, requireAdmin, async (c) => {
    const result = await setSpaceArchived(c.get("db"), c.get("user"), c.req.param("id"), false);
    if (result.ok) return c.json(toApiSpace(result.space), 200);
    if (result.error === "forbidden_personal") return apiError(c, 403, "forbidden", archivePersonalForbidden);
    return apiError(c, 404, "not_found", spaceNotFound);
  })
  .post("/", requireUser, requireAdmin, createSpaceBody, async (c) => {
    const input = c.req.valid("json");
    const db = c.get("db");
    if ((await countExistingUsers(db, input.memberIds)) !== input.memberIds.length) {
      return apiError(c, 400, "member_not_found", memberNotFound);
    }
    const id = crypto.randomUUID();
    const now = clock.now();
    // D1 statements rather than drizzle, so that the members are inserted in the same batch (one transaction):
    // a duplicate name leaves neither the space nor its members.
    const d1 = db.$client;
    const statements = [
      d1
        .prepare(`INSERT INTO spaces (id, kind, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)`)
        .bind(id, input.kind, input.name, now),
    ];
    if (input.memberIds.length > 0) statements.push(insertSpaceMembersStatement(d1, id, input.memberIds, now));
    try {
      await d1.batch(statements);
    } catch (error) {
      if (isSpaceUniqueViolation(error)) return apiError(c, 409, "name_taken", nameTaken);
      throw error;
    }
    const created = await findSpaceById(db, id);
    // Deleted by another request just after the creation.
    if (!created) return apiError(c, 404, "not_found", spaceNotFound);
    return c.json(toApiSpace(created), 201);
  })
  .patch("/:id", requireUser, requireAdmin, updateSpaceBody, async (c) => {
    const input = c.req.valid("json");
    const db = c.get("db");
    const space = await findAccessibleSpace(db, c.get("user"), c.req.param("id"));
    if (!space) return apiError(c, 404, "not_found", spaceNotFound);
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
    const space = await findAccessibleSpace(db, c.get("user"), c.req.param("id"));
    if (!space) return apiError(c, 404, "not_found", spaceNotFound);
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
  .get("/:id/members", requireUser, requireAdmin, async (c) => {
    const db = c.get("db");
    const space = await findAccessibleSpace(db, c.get("user"), c.req.param("id"));
    if (!space) return apiError(c, 404, "not_found", spaceNotFound);
    if (space.kind !== "members") return apiError(c, 400, "not_members_space", notMembersSpace);
    const body: SpaceMembers = { user_ids: await listSpaceMemberIds(db, space.id) };
    return c.json(body, 200);
  })
  // Replaces all the members. Archived spaces can be changed too, like their names. updated_at does not change:
  // the members are not the contents of the space.
  .put("/:id/members", requireUser, requireAdmin, setSpaceMembersBody, async (c) => {
    const { userIds } = c.req.valid("json");
    const db = c.get("db");
    const space = await findAccessibleSpace(db, c.get("user"), c.req.param("id"));
    if (!space) return apiError(c, 404, "not_found", spaceNotFound);
    if (space.kind !== "members") return apiError(c, 400, "not_members_space", notMembersSpace);
    if ((await countExistingUsers(db, userIds)) !== userIds.length) {
      return apiError(c, 400, "member_not_found", memberNotFound);
    }
    // One batch (one transaction) that starts with the DELETE, so that of two concurrent requests the later one
    // wins whole instead of the two being mixed.
    const d1 = db.$client;
    const statements = [deleteSpaceMembersStatement(d1, space.id)];
    if (userIds.length > 0) statements.push(insertSpaceMembersStatement(d1, space.id, userIds, clock.now()));
    await d1.batch(statements);
    // The space may have been deleted after the checks above; the INSERT then inserted nothing.
    if (!(await findSpaceById(db, space.id))) return apiError(c, 404, "not_found", spaceNotFound);
    const body: SpaceMembers = { user_ids: await listSpaceMemberIds(db, space.id) };
    return c.json(body, 200);
  })
  .get("/:id/pages", requireUser, async (c) => {
    const db = c.get("db");
    const space = await findAccessibleSpace(db, c.get("user"), c.req.param("id"));
    if (!space) return apiError(c, 404, "not_found", spaceNotFound);
    const rows = await listPageSummaries(db, space.id);
    const body: PageList = { pages: rows.map(toApiPageSummary) };
    return c.json(body, 200);
  })
  .post("/:id/pages", requireUser, createPageBody, async (c) => {
    const result = await createPage(c.get("db"), c.get("user"), c.req.param("id"), c.req.valid("json"));
    if (result.ok) return c.json(toApiPage(result.page), 201);
    if (result.error === "space_archived") return apiError(c, 409, "space_archived", spaceArchivedMessage);
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
    const space = await findAccessibleSpace(db, c.get("user"), c.req.param("id"));
    if (!space) return apiError(c, 404, "not_found", spaceNotFound);
    const rows = await listFolders(db, space.id);
    const body: FolderList = { folders: rows.map(toApiFolder) };
    return c.json(body, 200);
  })
  .post("/:id/folders", requireUser, createFolderBody, async (c) => {
    const result = await createFolder(c.get("db"), c.get("user"), c.req.param("id"), c.req.valid("json"));
    if (result.ok) return c.json(toApiFolder(result.folder), 201);
    if (result.error === "space_archived") return apiError(c, 409, "space_archived", spaceArchivedMessage);
    // 400 rather than 404: the space in the path exists, but the parent in the body does not.
    if (result.error === "parent_not_found") {
      return apiError(c, 400, "parent_not_found", parentNotFoundOnCreateMessage);
    }
    return apiError(c, 404, "not_found", spaceNotFound);
  });

export default spacesApi;
