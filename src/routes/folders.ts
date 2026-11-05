import { Hono, type Context } from "hono";
import type {
  CreateFolderInput,
  CreateFolderRequest,
  MoveFolderInput,
  MoveFolderRequest,
  UpdateFolderInput,
  UpdateFolderRequest,
} from "../api/types";
import type { AppEnv } from "../env";
import { apiError, requireUser } from "../auth/middleware";
import { findAccessibleFolder } from "../folders/queries";
import { deleteFolder, moveFolder, updateFolder } from "../folders/service";
import {
  emptyFolderUpdateMessage,
  folderCycleMessage,
  folderNotEmptyMessage,
  folderNotFoundMessage,
  invalidFolderNameMessage,
  invalidMoveSpaceIdMessage,
  invalidParentIdMessage,
  moveSpaceNotFoundMessage,
  normalizeFolderName,
  normalizeFolderRef,
  normalizeMoveSpaceId,
  parentNotFoundOnMoveMessage,
} from "../folders/validation";
import { spaceArchivedMessage } from "../spaces/archive";
import { jsonBody, toApiFolder } from "./api";

function invalidName(c: Context<AppEnv>): Response {
  return apiError(c, 400, "invalid_name", invalidFolderNameMessage);
}

function invalidParentId(c: Context<AppEnv>): Response {
  return apiError(c, 400, "invalid_parent_id", invalidParentIdMessage);
}

export const createFolderBody = jsonBody<CreateFolderRequest, CreateFolderInput>((body, c) => {
  const name = normalizeFolderName(body.name);
  if (name === null) return invalidName(c);
  const parentId = normalizeFolderRef(body.parent_id);
  if (!parentId.ok) return invalidParentId(c);
  return { ok: true, value: { name, parentId: parentId.value ?? null } };
});

const updateFolderBody = jsonBody<UpdateFolderRequest, UpdateFolderInput>((body, c) => {
  if (body.name === undefined && body.parent_id === undefined) {
    return apiError(c, 400, "empty_update", emptyFolderUpdateMessage);
  }
  const value: UpdateFolderInput = {};
  if (body.name !== undefined) {
    const name = normalizeFolderName(body.name);
    if (name === null) return invalidName(c);
    value.name = name;
  }
  if (body.parent_id !== undefined) {
    const parentId = normalizeFolderRef(body.parent_id);
    if (!parentId.ok) return invalidParentId(c);
    value.parentId = parentId.value;
  }
  return { ok: true, value };
});

// Validated in the order space_id, parent_id.
const moveFolderBody = jsonBody<MoveFolderRequest, MoveFolderInput>((body, c) => {
  const spaceId = normalizeMoveSpaceId(body.space_id);
  if (spaceId === null) return apiError(c, 400, "invalid_space_id", invalidMoveSpaceIdMessage);
  const parentId = normalizeFolderRef(body.parent_id);
  if (!parentId.ok) return invalidParentId(c);
  return { ok: true, value: { spaceId, parentId: parentId.value ?? null } };
});

// Folders in spaces the user cannot access are reported as missing so that their existence is not revealed.
const foldersApi = new Hono<AppEnv>()
  .get("/:id", requireUser, async (c) => {
    const folder = await findAccessibleFolder(c.get("db"), c.get("user"), c.req.param("id"));
    if (!folder) return apiError(c, 404, "not_found", folderNotFoundMessage);
    return c.json(toApiFolder(folder), 200);
  })
  .patch("/:id", requireUser, updateFolderBody, async (c) => {
    const result = await updateFolder(c.get("db"), c.get("user"), c.req.param("id"), c.req.valid("json"));
    if (result.ok) return c.json(toApiFolder(result.folder), 200);
    switch (result.error) {
      case "not_found":
        return apiError(c, 404, "not_found", folderNotFoundMessage);
      case "space_archived":
        return apiError(c, 409, "space_archived", spaceArchivedMessage);
      // 400 rather than 404: the folder in the path exists, but the parent in the body does not.
      case "parent_not_found":
        return apiError(c, 400, "parent_not_found", parentNotFoundOnMoveMessage);
      case "folder_cycle":
        return apiError(c, 409, "folder_cycle", folderCycleMessage);
    }
  })
  // Moves the folder with its contents to another space or inside its space. The Web UI warns before a
  // move that lets more people see the contents; the API does not ask for an acknowledgement (the MCP tool does).
  .post("/:id/move", requireUser, moveFolderBody, async (c) => {
    const result = await moveFolder(c.get("db"), c.get("user"), c.req.param("id"), c.req.valid("json"), {
      requireVisibilityAck: false,
      acknowledged: false,
    });
    if (result.ok) return c.json(toApiFolder(result.folder), 200);
    switch (result.error) {
      case "not_found":
        return apiError(c, 404, "not_found", folderNotFoundMessage);
      case "space_archived":
        return apiError(c, 409, "space_archived", spaceArchivedMessage);
      // 400 rather than 404: the folder in the path exists, but the space or parent in the body does not.
      case "space_not_found":
        return apiError(c, 400, "space_not_found", moveSpaceNotFoundMessage);
      case "parent_not_found":
        return apiError(c, 400, "parent_not_found", parentNotFoundOnMoveMessage);
      case "folder_cycle":
        return apiError(c, 409, "folder_cycle", folderCycleMessage);
      case "visibility_not_acknowledged":
        throw new Error("unreachable: the acknowledgement is not required");
    }
  })
  .delete("/:id", requireUser, async (c) => {
    const result = await deleteFolder(c.get("db"), c.get("user"), c.req.param("id"));
    if (result.ok) return c.body(null, 204);
    if (result.error === "not_found") return apiError(c, 404, "not_found", folderNotFoundMessage);
    if (result.error === "space_archived") return apiError(c, 409, "space_archived", spaceArchivedMessage);
    return apiError(c, 409, "folder_not_empty", folderNotEmptyMessage);
  });

export default foldersApi;
