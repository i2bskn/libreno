import { Hono, type Context } from "hono";
import type {
  AttachmentList,
  BacklinkList,
  CreatePageInput,
  CreatePageRequest,
  MovePageInput,
  MovePageRequest,
  PageRevisionList,
  RestorePageRevisionRequest,
  UpdatePageInput,
  UpdatePageRequest,
} from "../api/types";
import type { AppEnv } from "../env";
import { listAttachments } from "../attachments/service";
import { receiveUpload } from "../attachments/upload";
import {
  emptyFileMessage,
  fileTooLargeMessage,
  unsupportedTypeMessage,
  uploadFailedMessage,
} from "../attachments/validation";
import { apiError } from "@i2bskn/workers-app-core";
import { core } from "../core";
import {
  folderNotFoundMessage,
  invalidFolderIdMessage,
  invalidMoveSpaceIdMessage,
  moveSpaceNotFoundMessage,
  normalizeFolderRef,
  normalizeMoveSpaceId,
  parentNotFoundOnMoveMessage,
} from "../folders/validation";
import { listBacklinks } from "../pages/backlinks";
import { findAccessiblePage } from "../pages/queries";
import { findAccessiblePageRevision, listAccessiblePageRevisions, restorePageRevision } from "../pages/revisions";
import { movePage, updatePage } from "../pages/service";
import { purgeTrashedPage, restoreTrashedPage, trashPage } from "../pages/trash";
import { spaceArchivedMessage } from "../spaces/archive";
import {
  emptyUpdateMessage,
  invalidPageBodyMessage,
  invalidTitleMessage,
  invalidVersionMessage,
  isValidPageBody,
  normalizePageTitle,
  normalizeVersion,
  notInTrashOnPurgeMessage,
  notInTrashOnRestoreMessage,
  pageNotFoundMessage,
  parseVersionParam,
  purgeForbiddenRoleMessage,
  purgePersonalForbiddenMessage,
  revisionNotFoundMessage,
  versionConflictMessage,
} from "../pages/validation";
import {
  jsonBody,
  toApiAttachment,
  toApiPage,
  toApiPageRevision,
  toApiPageRevisionSummary,
  toApiPageSummary,
} from "./api";
import { attachmentBodyLimit, attachmentFilenameQuery } from "./attachments";

const { requireAdmin, requireUser } = core.middleware;

function invalidTitle(c: Context<AppEnv>): Response {
  return apiError(c, 400, "invalid_title", invalidTitleMessage);
}

// Not invalid_body, which jsonBody returns when the JSON is not an object.
function invalidPageBody(c: Context<AppEnv>): Response {
  return apiError(c, 400, "invalid_page_body", invalidPageBodyMessage);
}

function invalidFolderId(c: Context<AppEnv>): Response {
  return apiError(c, 400, "invalid_folder_id", invalidFolderIdMessage);
}

export const createPageBody = jsonBody<CreatePageRequest, CreatePageInput, AppEnv>((body, c) => {
  const title = normalizePageTitle(body.title);
  if (title === null) return invalidTitle(c);
  if (!isValidPageBody(body.body)) return invalidPageBody(c);
  const folderId = normalizeFolderRef(body.folder_id);
  if (!folderId.ok) return invalidFolderId(c);
  return { ok: true, value: { title, body: body.body, folderId: folderId.value ?? null } };
});

const updatePageBody = jsonBody<UpdatePageRequest, UpdatePageInput, AppEnv>((body, c) => {
  const version = normalizeVersion(body.version);
  if (version === null) return apiError(c, 400, "invalid_version", invalidVersionMessage);
  if (body.title === undefined && body.body === undefined && body.folder_id === undefined) {
    return apiError(c, 400, "empty_update", emptyUpdateMessage);
  }
  const value: UpdatePageInput = { version };
  if (body.title !== undefined) {
    const title = normalizePageTitle(body.title);
    if (title === null) return invalidTitle(c);
    value.title = title;
  }
  if (body.body !== undefined) {
    if (!isValidPageBody(body.body)) return invalidPageBody(c);
    value.body = body.body;
  }
  if (body.folder_id !== undefined) {
    const folderId = normalizeFolderRef(body.folder_id);
    if (!folderId.ok) return invalidFolderId(c);
    value.folderId = folderId.value;
  }
  return { ok: true, value };
});

// Validated in the order version, space_id, folder_id.
const movePageBody = jsonBody<MovePageRequest, MovePageInput, AppEnv>((body, c) => {
  const version = normalizeVersion(body.version);
  if (version === null) return apiError(c, 400, "invalid_version", invalidVersionMessage);
  const spaceId = normalizeMoveSpaceId(body.space_id);
  if (spaceId === null) return apiError(c, 400, "invalid_space_id", invalidMoveSpaceIdMessage);
  const folderId = normalizeFolderRef(body.folder_id);
  if (!folderId.ok) return invalidFolderId(c);
  return { ok: true, value: { version, spaceId, folderId: folderId.value ?? null } };
});

const restorePageRevisionBody = jsonBody<RestorePageRevisionRequest, RestorePageRevisionRequest, AppEnv>(
  (body, c) => {
    const version = normalizeVersion(body.version);
    if (version === null) return apiError(c, 400, "invalid_version", invalidVersionMessage);
    return { ok: true, value: { version } };
  },
);

const pagesApi = new Hono<AppEnv>()
  .get("/:id", requireUser, async (c) => {
    const page = await findAccessiblePage(c.get("db"), c.get("user"), c.req.param("id"));
    if (!page) return apiError(c, 404, "not_found", pageNotFoundMessage);
    return c.json(toApiPage(page), 200);
  })
  .patch("/:id", requireUser, updatePageBody, async (c) => {
    const result = await updatePage(c.get("db"), c.get("user"), c.req.param("id"), c.req.valid("json"));
    if (result.ok) return c.json(toApiPage(result.page), 200);
    if (result.error === "not_found") return apiError(c, 404, "not_found", pageNotFoundMessage);
    if (result.error === "space_archived") return apiError(c, 409, "space_archived", spaceArchivedMessage);
    // 400 rather than 404: the page in the path exists, but the folder in the body does not.
    if (result.error === "folder_not_found") return apiError(c, 400, "folder_not_found", folderNotFoundMessage);
    return apiError(c, 409, "version_conflict", versionConflictMessage);
  })
  // Moves the page to another space or inside its space. The Web UI warns before a move that lets more
  // people see the page; the API does not ask for an acknowledgement (the MCP tool does).
  .post("/:id/move", requireUser, movePageBody, async (c) => {
    const result = await movePage(c.get("db"), c.get("user"), c.req.param("id"), c.req.valid("json"), {
      requireVisibilityAck: false,
      acknowledged: false,
    });
    if (result.ok) return c.json(toApiPage(result.page), 200);
    switch (result.error) {
      case "not_found":
        return apiError(c, 404, "not_found", pageNotFoundMessage);
      case "space_archived":
        return apiError(c, 409, "space_archived", spaceArchivedMessage);
      // 400 rather than 404: the page in the path exists, but the space or folder in the body does not.
      case "space_not_found":
        return apiError(c, 400, "space_not_found", moveSpaceNotFoundMessage);
      case "folder_not_found":
        return apiError(c, 400, "folder_not_found", parentNotFoundOnMoveMessage);
      case "version_conflict":
        return apiError(c, 409, "version_conflict", versionConflictMessage);
      case "visibility_not_acknowledged":
        throw new Error("unreachable: the acknowledgement is not required");
    }
  })
  .get("/:id/revisions", requireUser, async (c) => {
    const result = await listAccessiblePageRevisions(c.get("db"), c.get("user"), c.req.param("id"));
    if (!result.ok) return apiError(c, 404, "not_found", pageNotFoundMessage);
    const body: PageRevisionList = { revisions: result.revisions.map(toApiPageRevisionSummary) };
    return c.json(body, 200);
  })
  .get("/:id/revisions/:version", requireUser, async (c) => {
    // An invalid version is reported after the page is checked, as revision_not_found.
    const version = parseVersionParam(c.req.param("version"));
    const result = await findAccessiblePageRevision(c.get("db"), c.get("user"), c.req.param("id"), version);
    if (result.ok) return c.json(toApiPageRevision(result.revision), 200);
    if (result.error === "not_found") return apiError(c, 404, "not_found", pageNotFoundMessage);
    return apiError(c, 404, "revision_not_found", revisionNotFoundMessage);
  })
  .post("/:id/revisions/:version/restore", requireUser, restorePageRevisionBody, async (c) => {
    const version = parseVersionParam(c.req.param("version"));
    const result = await restorePageRevision(
      c.get("db"),
      c.get("user"),
      c.req.param("id"),
      version,
      c.req.valid("json").version,
    );
    if (result.ok) return c.json(toApiPage(result.page), 200);
    if (result.error === "not_found") return apiError(c, 404, "not_found", pageNotFoundMessage);
    if (result.error === "space_archived") return apiError(c, 409, "space_archived", spaceArchivedMessage);
    if (result.error === "revision_not_found") return apiError(c, 404, "revision_not_found", revisionNotFoundMessage);
    return apiError(c, 409, "version_conflict", versionConflictMessage);
  })
  // The pages that link to the page. See pages/backlinks.ts for what counts as a link.
  .get("/:id/backlinks", requireUser, async (c) => {
    const result = await listBacklinks(c.get("db"), c.get("user"), c.req.param("id"));
    if (!result.ok) return apiError(c, 404, "not_found", pageNotFoundMessage);
    const body: BacklinkList = { pages: result.pages.map(toApiPageSummary), has_more: result.hasMore };
    return c.json(body, 200);
  })
  .get("/:id/attachments", requireUser, async (c) => {
    const result = await listAttachments(c.get("db"), c.get("user"), c.req.param("id"));
    if (!result.ok) return apiError(c, 404, "not_found", pageNotFoundMessage);
    const body: AttachmentList = { attachments: result.attachments.map(toApiAttachment) };
    return c.json(body, 200);
  })
  // Attaches a file to the page. The body is the file itself, not multipart, which would cost CPU time to
  // parse. The type is decided from the contents; the Content-Type of the request is not used. See
  // attachments/upload.ts for how the body is read.
  .post("/:id/attachments", requireUser, attachmentFilenameQuery, attachmentBodyLimit, async (c) => {
    const result = await receiveUpload(
      c.get("db"),
      c.env.ATTACHMENTS,
      c.get("user"),
      c.req.param("id"),
      c.req.valid("query").filename,
      c.req.raw,
    );
    if (!result.ok) {
      switch (result.error) {
        case "empty_file":
          return apiError(c, 400, "empty_file", emptyFileMessage);
        case "file_too_large":
          return apiError(c, 413, "file_too_large", fileTooLargeMessage);
        case "unsupported_type":
          return apiError(c, 400, "unsupported_type", unsupportedTypeMessage);
        case "upload_failed":
          return apiError(c, 400, "upload_failed", uploadFailedMessage);
        case "not_found":
          return apiError(c, 404, "not_found", pageNotFoundMessage);
        case "space_archived":
          return apiError(c, 409, "space_archived", spaceArchivedMessage);
      }
    }
    return c.json(toApiAttachment(result.attachment), 201);
  })
  // Moves the page to the trash of its space. It can be restored for 30 days (see pages/trash.ts).
  .delete("/:id", requireUser, async (c) => {
    const result = await trashPage(c.get("db"), c.get("user"), c.req.param("id"));
    if (!result.ok && result.error === "space_archived") return apiError(c, 409, "space_archived", spaceArchivedMessage);
    if (!result.ok) return apiError(c, 404, "not_found", pageNotFoundMessage);
    return c.body(null, 204);
  })
  .post("/:id/restore", requireUser, async (c) => {
    const result = await restoreTrashedPage(c.get("db"), c.get("user"), c.req.param("id"));
    if (result.ok) return c.json(toApiPage(result.page), 200);
    if (result.error === "not_found") return apiError(c, 404, "not_found", pageNotFoundMessage);
    if (result.error === "space_archived") return apiError(c, 409, "space_archived", spaceArchivedMessage);
    return apiError(c, 409, "not_in_trash", notInTrashOnRestoreMessage);
  })
  // Deletes a page in the trash with its revisions. This cannot be undone.
  .delete("/:id/permanent", requireUser, requireAdmin, async (c) => {
    const result = await purgeTrashedPage(c.get("db"), c.get("user"), c.req.param("id"));
    if (result.ok) return c.body(null, 204);
    switch (result.error) {
      case "not_found":
        return apiError(c, 404, "not_found", pageNotFoundMessage);
      case "space_archived":
        return apiError(c, 409, "space_archived", spaceArchivedMessage);
      case "not_in_trash":
        return apiError(c, 409, "not_in_trash", notInTrashOnPurgeMessage);
      case "forbidden_role":
        return apiError(c, 403, "forbidden", purgeForbiddenRoleMessage);
      case "forbidden_personal":
        return apiError(c, 403, "forbidden", purgePersonalForbiddenMessage);
    }
  });

export default pagesApi;
