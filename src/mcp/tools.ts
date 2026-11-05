import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { and, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import type {
  AttachmentList,
  FolderList,
  PageList,
  PageRevisionList,
  SearchResult,
  SpaceKind,
  SpaceList,
  TrashList,
  UpdateFolderInput,
  UpdatePageInput,
} from "../api/types";
import { createAttachment, listAttachments } from "../attachments/service";
import {
  checkAttachmentContent,
  decodeBase64,
  emptyFileMessage,
  invalidBase64Message,
  invalidFilenameMessage,
  MCP_ATTACHMENT_MAX_BYTES,
  MCP_MAX_BASE64_LENGTH,
  mcpFileTooLargeMessage,
  normalizeAttachmentFilename,
  unsupportedTypeMessage,
  withAttachmentExtension,
} from "../attachments/validation";
import { describeError } from "../auth/middleware";
import type { Db } from "../db/client";
import { spaces, type UserRow } from "../db/schema";
import { listFolders } from "../folders/queries";
import { createFolder, deleteFolder, moveFolder, updateFolder } from "../folders/service";
import {
  emptyFolderUpdateMessage,
  folderCycleMessage,
  folderNotEmptyMessage,
  folderNotFoundMessage,
  invalidFolderIdMessage,
  invalidFolderNameMessage,
  invalidMoveSpaceIdMessage,
  invalidParentIdMessage,
  moveSpaceNotFoundMessage,
  normalizeFolderName,
  normalizeFolderRef,
  normalizeMoveSpaceId,
  parentNotFoundOnCreateMessage,
  parentNotFoundOnMoveMessage,
} from "../folders/validation";
import { findAccessiblePage, listPageSummaries } from "../pages/queries";
import { findAccessiblePageRevision, listAccessiblePageRevisions, restorePageRevision } from "../pages/revisions";
import { searchAccessiblePages } from "../pages/search";
import { createPage, movePage, updatePage } from "../pages/service";
import { listTrash, restoreTrashedPage, trashPage } from "../pages/trash";
import {
  emptyUpdateMessage,
  invalidPageBodyMessage,
  invalidSearchQueryMessage,
  invalidTitleMessage,
  invalidVersionMessage,
  isValidPageBody,
  normalizePageTitle,
  normalizeSearchQuery,
  normalizeVersion,
  notInTrashOnRestoreMessage,
  pageNotFoundMessage,
  revisionNotFoundMessage,
  versionConflictMessage,
} from "../pages/validation";
import {
  toApiAttachment,
  toApiFolder,
  toApiPage,
  toApiPageRevision,
  toApiPageRevisionSummary,
  toApiPageSummary,
  toApiSearchHit,
  toApiSpace,
  toApiTrashedPage,
} from "../routes/api";
import { accessibleSpacesWhere, canAccessSpace, type VisibilityNotAcknowledged } from "../spaces/access";
import { spaceArchivedMessage } from "../spaces/archive";
import { findSpaceById, spaceListOrder } from "../spaces/queries";

export type ToolDeps = { db: Db; user: UserRow; attachments: R2Bucket };

// Results are JSON text only. No structuredContent: a page body can be up to 512KB, and
// sending it twice would double the response.
function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// Unexpected errors are logged and reported with a fixed message, so that SQL and parameters
// in error messages never reach the client.
async function guard(tool: string, run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    console.error("mcp tool failed", { tool, ...describeError(error) });
    return errorResult("サーバーでエラーが発生しました");
  }
}

// The names of the space kinds in the messages of the move tools.
const SPACE_KIND_NAMES: Record<SpaceKind, string> = {
  personal: "個人（本人のみ）",
  admin: "管理者のみ",
  everyone: "全員",
};

function visibilityNotAcknowledgedMessage(result: VisibilityNotAcknowledged): string {
  return (
    `移動先のスペース「${result.destName}」（${SPACE_KIND_NAMES[result.to]}）は、` +
    `移動元（${SPACE_KIND_NAMES[result.from]}）より多くの人が見られます。` +
    "ページの過去の版（履歴）と添付ファイルも見られるようになります。" +
    "利用者に確認してから acknowledge_wider_visibility: true を付けて呼んでください"
  );
}

// openWorldHint defaults to true, so it is set explicitly: the tools only touch this wiki.
const readOnlyAnnotations = { readOnlyHint: true, openWorldHint: false };

// Access checks go through spaces/access.ts and pages/queries.ts only, as in the REST API.
export function registerTools(server: McpServer, { db, user, attachments }: ToolDeps): void {
  server.registerTool(
    "list_spaces",
    {
      description:
        "List the spaces the signed-in user can access, by sort_order ascending (creation order for equal values), " +
        "with the personal space last. Each space has an id, a kind, a name and a sort_order. " +
        "kind is 'everyone' (all users), 'admin' (admins only) or 'personal'. " +
        "The personal space (kind=personal, name=null) belongs to the calling user and is private to them. " +
        "archived_at is the time the space was archived, or null if it is not archived. " +
        "Archived spaces are read only and are listed only with archived=true; their pages can still be read. " +
        "Use a space id with list_pages.",
      inputSchema: {
        archived: z
          .boolean()
          .optional()
          .describe("Set to true to list only the archived spaces. Omit or false to list the others"),
      },
      annotations: readOnlyAnnotations,
    },
    ({ archived }) =>
      guard("list_spaces", async () => {
        const rows = await db
          .select()
          .from(spaces)
          .where(
            and(
              accessibleSpacesWhere(user),
              archived === true ? isNotNull(spaces.archivedAt) : isNull(spaces.archivedAt),
            ),
          )
          .orderBy(...spaceListOrder)
          .all();
        const body: SpaceList = { spaces: rows.map(toApiSpace) };
        return jsonResult(body);
      }),
  );

  server.registerTool(
    "list_pages",
    {
      description:
        "List the pages in a space, most recently updated first. Returns titles and metadata without page bodies. " +
        "folder_id is the folder the page is in (see list_folders), or null at the top level of the space. " +
        "Use get_page with a page id to read the body.",
      inputSchema: { space_id: z.string().describe("The id of a space returned by list_spaces") },
      annotations: readOnlyAnnotations,
    },
    ({ space_id }) =>
      guard("list_pages", async () => {
        const space = await findSpaceById(db, space_id);
        // Spaces the user cannot access are reported as missing so that their existence is not revealed.
        if (!space || !canAccessSpace(user, space)) return errorResult("スペースが見つかりません");
        const rows = await listPageSummaries(db, space.id);
        const body: PageList = { pages: rows.map(toApiPageSummary) };
        return jsonResult(body);
      }),
  );

  server.registerTool(
    "get_page",
    {
      description:
        "Get a page with its Markdown body and metadata. version is incremented on every update. " +
        "To link to another page in a body, write [title](/pages/{page_id}). " +
        "To find the pages that link to a page, call search_pages with the query /pages/{page_id}.",
      inputSchema: { page_id: z.string().describe("The id of a page returned by list_pages") },
      annotations: readOnlyAnnotations,
    },
    ({ page_id }) =>
      guard("get_page", async () => {
        const page = await findAccessiblePage(db, user, page_id);
        if (!page) return errorResult(pageNotFoundMessage);
        return jsonResult(toApiPage(page));
      }),
  );

  server.registerTool(
    "search_pages",
    {
      description:
        "Search pages by a substring of the title or the body, in the spaces the signed-in user can access. " +
        "Matching is case-insensitive for ASCII letters only; there is no word splitting, so the whole query is matched as one string. " +
        "Pages whose title matches come first, then the most recently updated. Returns up to 50 pages without bodies, " +
        "each with a snippet of the body around the first match (null when only the title matches). " +
        "has_more is true when more pages matched; narrow the query or pass space_id. Use get_page to read a body. " +
        "Without space_id, archived spaces are not searched; pass the space_id of an archived space to search it.",
      inputSchema: {
        // Not .min()/.max(): normalizeSearchQuery checks it, so that the message is the same as in the REST API.
        query: z.string().describe("The text to search for, 1 to 100 characters"),
        space_id: z
          .string()
          .optional()
          .describe("Limit the search to this space, an id returned by list_spaces"),
      },
      annotations: readOnlyAnnotations,
    },
    ({ query, space_id }) =>
      guard("search_pages", async () => {
        // Validated in the same order as GET /api/v1/search.
        const normalizedQuery = normalizeSearchQuery(query);
        if (normalizedQuery === null) return errorResult(invalidSearchQueryMessage);
        const result = await searchAccessiblePages(db, user, normalizedQuery, space_id);
        if (!result.ok) return errorResult("スペースが見つかりません");
        const body: SearchResult = { hits: result.result.hits.map(toApiSearchHit), has_more: result.result.hasMore };
        return jsonResult(body);
      }),
  );

  server.registerTool(
    "create_page",
    {
      description:
        "Create a page in a space, optionally in a folder of that space. The body is Markdown. " +
        "Returns the new page's metadata (id, version, ...) without the body. " +
        "A page in the personal space (kind=personal) is visible only to the calling user; " +
        "a page in an 'everyone' space is visible to all users. " +
        "Link to other pages with [title](/pages/{page_id}).",
      inputSchema: {
        space_id: z.string().describe("The id of a space returned by list_spaces"),
        title: z.string().describe("The page title, 1 to 200 characters, without line breaks"),
        body: z.string().describe("The page body in Markdown, up to 512KB"),
        folder_id: z
          .string()
          .optional()
          .describe("The id of a folder in the same space, from list_folders. Omit to create the page at the top level"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ space_id, title, body, folder_id }) =>
      guard("create_page", async () => {
        // Validated in the same order as POST /api/v1/spaces/:id/pages.
        const normalizedTitle = normalizePageTitle(title);
        if (normalizedTitle === null) return errorResult(invalidTitleMessage);
        if (!isValidPageBody(body)) return errorResult(invalidPageBodyMessage);
        const folderId = normalizeFolderRef(folder_id);
        if (!folderId.ok) return errorResult(invalidFolderIdMessage);
        const result = await createPage(db, user, space_id, {
          title: normalizedTitle,
          body,
          folderId: folderId.value ?? null,
        });
        if (!result.ok) {
          if (result.error === "space_archived") return errorResult(spaceArchivedMessage);
          return errorResult(result.error === "folder_not_found" ? folderNotFoundMessage : "スペースが見つかりません");
        }
        // No body: the caller has just sent it, and it can be up to 512KB.
        return jsonResult(toApiPageSummary(result.page));
      }),
  );

  server.registerTool(
    "update_page",
    {
      description:
        "Update the title, the Markdown body and/or the folder of a page. " +
        "folder_id moves the page to a folder in the same space; null moves it to the top level. " +
        "To move a page to another space, use move_page. " +
        "version must be the current version from get_page; if someone else updated the page first, " +
        "the call fails and nothing is changed. body replaces the whole body. " +
        "The previous title and body are kept as a revision (the newest 20 per page); " +
        "use list_page_revisions and restore_page_revision to go back. " +
        "Returns the page's metadata without the body. " +
        "Link to other pages with [title](/pages/{page_id}).",
      inputSchema: {
        page_id: z.string().describe("The id of a page returned by list_pages"),
        // Not z.number().int(): normalizeVersion checks it, so that the message is the same as in the REST API.
        version: z
          .number()
          .describe(
            "The current version of the page from get_page, an integer of 1 or more. " +
              "If someone else updated the page first, the call fails",
          ),
        title: z
          .string()
          .optional()
          .describe("The new title, 1 to 200 characters, without line breaks. Omit to keep the current title"),
        body: z
          .string()
          .optional()
          .describe("The new body in Markdown, up to 512KB. Replaces the whole body. Omit to keep the current body"),
        folder_id: z
          .string()
          .nullable()
          .optional()
          .describe(
            "The id of a folder in the same space to move the page to, from list_folders. " +
              "null moves it to the top level of the space. Omit to keep the current folder",
          ),
      },
      // Destructive: only the newest 20 revisions are kept, so older content is deleted by the update.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    ({ page_id, version, title, body, folder_id }) =>
      guard("update_page", async () => {
        // Validated in the same order as PATCH /api/v1/pages/:id.
        const normalizedVersion = normalizeVersion(version);
        if (normalizedVersion === null) return errorResult(invalidVersionMessage);
        if (title === undefined && body === undefined && folder_id === undefined) {
          return errorResult(emptyUpdateMessage);
        }
        const input: UpdatePageInput = { version: normalizedVersion };
        if (title !== undefined) {
          const normalizedTitle = normalizePageTitle(title);
          if (normalizedTitle === null) return errorResult(invalidTitleMessage);
          input.title = normalizedTitle;
        }
        if (body !== undefined) {
          if (!isValidPageBody(body)) return errorResult(invalidPageBodyMessage);
          input.body = body;
        }
        if (folder_id !== undefined) {
          const folderId = normalizeFolderRef(folder_id);
          if (!folderId.ok) return errorResult(invalidFolderIdMessage);
          input.folderId = folderId.value;
        }
        const result = await updatePage(db, user, page_id, input);
        if (result.ok) return jsonResult(toApiPageSummary(result.page));
        if (result.error === "not_found") return errorResult(pageNotFoundMessage);
        if (result.error === "space_archived") return errorResult(spaceArchivedMessage);
        if (result.error === "folder_not_found") return errorResult(folderNotFoundMessage);
        return errorResult(
          `${versionConflictMessage}。get_page で最新の version と本文を取得し、変更を反映し直してから update_page を呼んでください`,
        );
      }),
  );

  // Moves that narrow the visibility (e.g. everyone to personal) need no acknowledgement: other users stop
  // seeing the page, but nothing is deleted and it can be moved back, so the tools are not destructive.
  server.registerTool(
    "move_page",
    {
      description:
        "Move a page to another space (or to another folder of its space). The user needs access to both spaces. " +
        "Who can see the page changes to the destination space's kind (see list_spaces), and the earlier " +
        "versions of the page (revisions) move with it and become visible there too. " +
        "Moving to a space that more people can see (personal to admin or everyone, admin to everyone) fails " +
        "unless acknowledge_wider_visibility is true: ask the user to confirm first, then call again with it. " +
        "Moving to a space that fewer people can see hides the page from the other users. " +
        "version must be the current version from get_page; the version is incremented. " +
        "Returns the page's metadata without the body.",
      inputSchema: {
        page_id: z.string().describe("The id of a page returned by list_pages"),
        // Not z.number().int(): normalizeVersion checks it, so that the message is the same as in the REST API.
        version: z
          .number()
          .describe(
            "The current version of the page from get_page, an integer of 1 or more. " +
              "If someone else updated the page first, the call fails",
          ),
        space_id: z.string().describe("The id of the destination space, returned by list_spaces"),
        folder_id: z
          .string()
          .nullable()
          .optional()
          .describe(
            "The id of a folder in the destination space, from list_folders. " +
              "Omit or null to move the page to the top level of the destination space",
          ),
        acknowledge_wider_visibility: z
          .boolean()
          .optional()
          .describe(
            "Set to true only after the user has confirmed that more people may see the page and its revisions",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ page_id, version, space_id, folder_id, acknowledge_wider_visibility }) =>
      guard("move_page", async () => {
        // Validated in the same order as POST /api/v1/pages/:id/move.
        const normalizedVersion = normalizeVersion(version);
        if (normalizedVersion === null) return errorResult(invalidVersionMessage);
        const spaceId = normalizeMoveSpaceId(space_id);
        if (spaceId === null) return errorResult(invalidMoveSpaceIdMessage);
        const folderId = normalizeFolderRef(folder_id);
        if (!folderId.ok) return errorResult(invalidFolderIdMessage);
        const result = await movePage(
          db,
          user,
          page_id,
          { version: normalizedVersion, spaceId, folderId: folderId.value ?? null },
          { requireVisibilityAck: true, acknowledged: acknowledge_wider_visibility === true },
        );
        if (result.ok) return jsonResult(toApiPageSummary(result.page));
        switch (result.error) {
          case "not_found":
            return errorResult(pageNotFoundMessage);
          case "space_archived":
            return errorResult(spaceArchivedMessage);
          case "space_not_found":
            return errorResult(moveSpaceNotFoundMessage);
          case "folder_not_found":
            return errorResult(parentNotFoundOnMoveMessage);
          case "version_conflict":
            return errorResult(
              `${versionConflictMessage}。get_page で最新の version を取得してから move_page を呼んでください`,
            );
          case "visibility_not_acknowledged":
            return errorResult(visibilityNotAcknowledgedMessage(result));
        }
      }),
  );

  server.registerTool(
    "delete_page",
    {
      description:
        "Move a page to the trash of its space. It can be restored with restore_page for 30 days, " +
        "after which it is deleted with its revisions. " +
        "Pages in the trash do not appear in list_pages, get_page or search_pages.",
      inputSchema: { page_id: z.string().describe("The id of a page returned by list_pages") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ page_id }) =>
      guard("delete_page", async () => {
        const result = await trashPage(db, user, page_id);
        if (!result.ok && result.error === "space_archived") return errorResult(spaceArchivedMessage);
        if (!result.ok) return errorResult(pageNotFoundMessage);
        return jsonResult({ id: page_id, trashed: true });
      }),
  );

  server.registerTool(
    "list_trash",
    {
      description:
        "List the pages in the trash of a space, most recently deleted first, without their bodies. " +
        "deleted_at is when the page was moved to the trash, and purge_after is when it will be deleted " +
        "with its revisions (30 days later). Use restore_page to take a page out of the trash.",
      inputSchema: { space_id: z.string().describe("The id of a space returned by list_spaces") },
      annotations: readOnlyAnnotations,
    },
    ({ space_id }) =>
      guard("list_trash", async () => {
        const result = await listTrash(db, user, space_id);
        if (!result.ok) return errorResult("スペースが見つかりません");
        const body: TrashList = { pages: result.pages.map(toApiTrashedPage) };
        return jsonResult(body);
      }),
  );

  server.registerTool(
    "restore_page",
    {
      description:
        "Take a page out of the trash of its space, back to its folder (or to the top level if the folder was deleted). " +
        "The title, body and version do not change. " +
        "This is not restore_page_revision, which goes back to an earlier version of a page that is not in the trash. " +
        "Returns the page's metadata without the body.",
      inputSchema: { page_id: z.string().describe("The id of a page returned by list_trash") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ page_id }) =>
      guard("restore_page", async () => {
        const result = await restoreTrashedPage(db, user, page_id);
        if (result.ok) return jsonResult(toApiPageSummary(result.page));
        if (result.error === "not_found") return errorResult(pageNotFoundMessage);
        if (result.error === "space_archived") return errorResult(spaceArchivedMessage);
        return errorResult(notInTrashOnRestoreMessage);
      }),
  );

  server.registerTool(
    "list_page_revisions",
    {
      description:
        "List the earlier versions (revisions) of a page, newest first, without their bodies. " +
        "The current content is not included; use get_page for it. Only the newest 20 revisions are kept per page. " +
        "Each revision has the version the page had when that was its content. " +
        "Use get_page_revision to read one, and restore_page_revision to go back to it.",
      inputSchema: { page_id: z.string().describe("The id of a page returned by list_pages") },
      annotations: readOnlyAnnotations,
    },
    ({ page_id }) =>
      guard("list_page_revisions", async () => {
        const result = await listAccessiblePageRevisions(db, user, page_id);
        if (!result.ok) return errorResult(pageNotFoundMessage);
        const body: PageRevisionList = { revisions: result.revisions.map(toApiPageRevisionSummary) };
        return jsonResult(body);
      }),
  );

  server.registerTool(
    "get_page_revision",
    {
      description: "Get an earlier version (revision) of a page with its title and Markdown body.",
      inputSchema: {
        page_id: z.string().describe("The id of a page returned by list_pages"),
        // Not z.number().int(): an invalid one is reported as a missing revision, as in the REST API.
        revision_version: z.number().describe("The version of a revision returned by list_page_revisions"),
      },
      annotations: readOnlyAnnotations,
    },
    ({ page_id, revision_version }) =>
      guard("get_page_revision", async () => {
        // An invalid revision_version is reported after the page is checked, as in the REST API.
        const result = await findAccessiblePageRevision(db, user, page_id, normalizeVersion(revision_version));
        if (result.ok) return jsonResult(toApiPageRevision(result.revision));
        if (result.error === "not_found") return errorResult(pageNotFoundMessage);
        return errorResult(revisionNotFoundMessage);
      }),
  );

  server.registerTool(
    "restore_page_revision",
    {
      description:
        "Go back to an earlier version (revision) of a page: its title and body become the page's content. " +
        "The current title and body are kept as a new revision, the version is incremented, and the folder does not change. " +
        "revision_version: the version to go back to, from list_page_revisions. " +
        "version: the current version of the page from get_page; if someone else updated the page first, " +
        "the call fails and nothing is changed. Only the newest 20 revisions are kept, so the oldest one may be deleted. " +
        "Returns the page's metadata without the body.",
      inputSchema: {
        page_id: z.string().describe("The id of a page returned by list_pages"),
        revision_version: z.number().describe("The version to go back to, from list_page_revisions"),
        // Not z.number().int(): normalizeVersion checks it, so that the message is the same as in the REST API.
        version: z
          .number()
          .describe(
            "The current version of the page from get_page, an integer of 1 or more. " +
              "If someone else updated the page first, the call fails",
          ),
      },
      // Destructive like update_page: the update deletes revisions older than the newest 20.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    ({ page_id, revision_version, version }) =>
      guard("restore_page_revision", async () => {
        // Validated in the same order as POST /api/v1/pages/:id/revisions/:version/restore.
        const normalizedVersion = normalizeVersion(version);
        if (normalizedVersion === null) return errorResult(invalidVersionMessage);
        const result = await restorePageRevision(
          db,
          user,
          page_id,
          normalizeVersion(revision_version),
          normalizedVersion,
        );
        if (result.ok) return jsonResult(toApiPageSummary(result.page));
        if (result.error === "not_found") return errorResult(pageNotFoundMessage);
        if (result.error === "space_archived") return errorResult(spaceArchivedMessage);
        if (result.error === "revision_not_found") return errorResult(revisionNotFoundMessage);
        return errorResult(
          `${versionConflictMessage}。get_page で最新の version を取得してから restore_page_revision を呼んでください`,
        );
      }),
  );

  server.registerTool(
    "upload_attachment",
    {
      description:
        "Attach an image (PNG, JPEG, GIF or WebP) or a PDF to a page, up to 2MB; larger files can be attached " +
        "from the page editor of the Web UI. The type is decided from the contents, and the extension of the " +
        "type is added to filename if it is missing. Anyone who can read the page can read the file. " +
        "Returns the attachment with markdown, the Markdown that shows or links the file: " +
        "to put it in the page body, use update_page. Attachments cannot be deleted with these tools.",
      inputSchema: {
        page_id: z.string().describe("The id of a page returned by list_pages"),
        filename: z.string().describe("The file name, 1 to 250 characters"),
        // Not .max(): the length is checked in the handler, so that the message is in Japanese like the others.
        content_base64: z
          .string()
          .describe("The contents of the file in standard base64 (not base64url). Whitespace and line breaks are ignored"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ page_id, filename, content_base64 }) =>
      guard("upload_attachment", async () => {
        // Validated in the same order as POST /api/v1/pages/:id/attachments.
        const normalizedFilename = normalizeAttachmentFilename(filename);
        if (normalizedFilename === null) return errorResult(invalidFilenameMessage);
        if (content_base64.length > MCP_MAX_BASE64_LENGTH) return errorResult(mcpFileTooLargeMessage);
        const bytes = decodeBase64(content_base64);
        if (bytes === null) return errorResult(invalidBase64Message);
        const checked = checkAttachmentContent(bytes, MCP_ATTACHMENT_MAX_BYTES);
        if (!checked.ok) {
          switch (checked.error) {
            case "empty_file":
              return errorResult(emptyFileMessage);
            case "file_too_large":
              return errorResult(mcpFileTooLargeMessage);
            case "unsupported_type":
              return errorResult(unsupportedTypeMessage);
          }
        }
        const result = await createAttachment(db, attachments, user, page_id, {
          filename: withAttachmentExtension(normalizedFilename, checked.contentType),
          contentType: checked.contentType,
          content: { kind: "bytes", bytes },
        });
        if (!result.ok) {
          return errorResult(result.error === "space_archived" ? spaceArchivedMessage : pageNotFoundMessage);
        }
        return jsonResult(toApiAttachment(result.attachment));
      }),
  );

  server.registerTool(
    "list_attachments",
    {
      description:
        "List the files attached to a page, oldest first. Each has a filename, a content_type, a size in bytes, " +
        "the url of its contents and markdown, the Markdown that shows or links the file in a page body.",
      inputSchema: { page_id: z.string().describe("The id of a page returned by list_pages") },
      annotations: readOnlyAnnotations,
    },
    ({ page_id }) =>
      guard("list_attachments", async () => {
        const result = await listAttachments(db, user, page_id);
        if (!result.ok) return errorResult(pageNotFoundMessage);
        const body: AttachmentList = { attachments: result.attachments.map(toApiAttachment) };
        return jsonResult(body);
      }),
  );

  server.registerTool(
    "list_folders",
    {
      description:
        "List all folders in a space as a flat list, ordered by name. Folders organize pages and can be nested. " +
        "parent_id is the folder it is in, or null at the top level of the space; build the tree with parent_id. " +
        "A page's folder_id (from list_pages) refers to one of these folders.",
      inputSchema: { space_id: z.string().describe("The id of a space returned by list_spaces") },
      annotations: readOnlyAnnotations,
    },
    ({ space_id }) =>
      guard("list_folders", async () => {
        const space = await findSpaceById(db, space_id);
        // Spaces the user cannot access are reported as missing so that their existence is not revealed.
        if (!space || !canAccessSpace(user, space)) return errorResult("スペースが見つかりません");
        const rows = await listFolders(db, space.id);
        const body: FolderList = { folders: rows.map(toApiFolder) };
        return jsonResult(body);
      }),
  );

  server.registerTool(
    "create_folder",
    {
      description:
        "Create a folder in a space, at the top level or inside another folder of the same space. " +
        "Folders have no permissions of their own: everyone who can access the space can use them. " +
        "Names need not be unique. Returns the new folder.",
      inputSchema: {
        space_id: z.string().describe("The id of a space returned by list_spaces"),
        name: z.string().describe("The folder name, 1 to 100 characters, without line breaks"),
        parent_id: z
          .string()
          .optional()
          .describe("The id of a folder in the same space to create this folder in. Omit for the top level"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ space_id, name, parent_id }) =>
      guard("create_folder", async () => {
        // Validated in the same order as POST /api/v1/spaces/:id/folders.
        const normalizedName = normalizeFolderName(name);
        if (normalizedName === null) return errorResult(invalidFolderNameMessage);
        const parentId = normalizeFolderRef(parent_id);
        if (!parentId.ok) return errorResult(invalidParentIdMessage);
        const result = await createFolder(db, user, space_id, {
          name: normalizedName,
          parentId: parentId.value ?? null,
        });
        if (result.ok) return jsonResult(toApiFolder(result.folder));
        if (result.error === "space_archived") return errorResult(spaceArchivedMessage);
        if (result.error === "parent_not_found") return errorResult(parentNotFoundOnCreateMessage);
        return errorResult("スペースが見つかりません");
      }),
  );

  server.registerTool(
    "update_folder",
    {
      description:
        "Rename a folder and/or move it to another folder in the same space. " +
        "parent_id null moves it to the top level of the space. A folder cannot be moved into itself or " +
        "one of its subfolders. To move a folder to another space, use move_folder. " +
        "Its pages and subfolders move with it. Returns the folder.",
      inputSchema: {
        folder_id: z.string().describe("The id of a folder returned by list_folders"),
        name: z
          .string()
          .optional()
          .describe("The new name, 1 to 100 characters, without line breaks. Omit to keep the current name"),
        parent_id: z
          .string()
          .nullable()
          .optional()
          .describe(
            "The id of a folder in the same space to move this folder into, or null for the top level. " +
              "Omit to keep the current parent",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ folder_id, name, parent_id }) =>
      guard("update_folder", async () => {
        // Validated in the same order as PATCH /api/v1/folders/:id.
        if (name === undefined && parent_id === undefined) return errorResult(emptyFolderUpdateMessage);
        const input: UpdateFolderInput = {};
        if (name !== undefined) {
          const normalizedName = normalizeFolderName(name);
          if (normalizedName === null) return errorResult(invalidFolderNameMessage);
          input.name = normalizedName;
        }
        if (parent_id !== undefined) {
          const parentId = normalizeFolderRef(parent_id);
          if (!parentId.ok) return errorResult(invalidParentIdMessage);
          input.parentId = parentId.value;
        }
        const result = await updateFolder(db, user, folder_id, input);
        if (result.ok) return jsonResult(toApiFolder(result.folder));
        switch (result.error) {
          case "not_found":
            return errorResult(folderNotFoundMessage);
          case "space_archived":
            return errorResult(spaceArchivedMessage);
          case "parent_not_found":
            return errorResult(parentNotFoundOnMoveMessage);
          case "folder_cycle":
            return errorResult(folderCycleMessage);
        }
      }),
  );

  // As with move_page, moves that narrow the visibility need no acknowledgement.
  server.registerTool(
    "move_folder",
    {
      description:
        "Move a folder to another space (or to another folder of its space) with everything in it: its subfolders " +
        "and pages, including pages in the trash, keep their place inside it. The user needs access to both spaces. " +
        "Who can see the contents changes to the destination space's kind (see list_spaces), and the earlier " +
        "versions of the pages (revisions) move with them and become visible there too. " +
        "Moving to a space that more people can see (personal to admin or everyone, admin to everyone) fails " +
        "unless acknowledge_wider_visibility is true: ask the user to confirm first, then call again with it. " +
        "Moving to a space that fewer people can see hides the contents from the other users. " +
        "A folder cannot be moved into itself or one of its subfolders. Returns the folder.",
      inputSchema: {
        folder_id: z.string().describe("The id of a folder returned by list_folders"),
        space_id: z.string().describe("The id of the destination space, returned by list_spaces"),
        parent_id: z
          .string()
          .nullable()
          .optional()
          .describe(
            "The id of a folder in the destination space to move this folder into, from list_folders. " +
              "Omit or null to move it to the top level of the destination space",
          ),
        acknowledge_wider_visibility: z
          .boolean()
          .optional()
          .describe(
            "Set to true only after the user has confirmed that more people may see the contents and their revisions",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ folder_id, space_id, parent_id, acknowledge_wider_visibility }) =>
      guard("move_folder", async () => {
        // Validated in the same order as POST /api/v1/folders/:id/move.
        const spaceId = normalizeMoveSpaceId(space_id);
        if (spaceId === null) return errorResult(invalidMoveSpaceIdMessage);
        const parentId = normalizeFolderRef(parent_id);
        if (!parentId.ok) return errorResult(invalidParentIdMessage);
        const result = await moveFolder(
          db,
          user,
          folder_id,
          { spaceId, parentId: parentId.value ?? null },
          { requireVisibilityAck: true, acknowledged: acknowledge_wider_visibility === true },
        );
        if (result.ok) return jsonResult(toApiFolder(result.folder));
        switch (result.error) {
          case "not_found":
            return errorResult(folderNotFoundMessage);
          case "space_archived":
            return errorResult(spaceArchivedMessage);
          case "space_not_found":
            return errorResult(moveSpaceNotFoundMessage);
          case "parent_not_found":
            return errorResult(parentNotFoundOnMoveMessage);
          case "folder_cycle":
            return errorResult(folderCycleMessage);
          case "visibility_not_acknowledged":
            return errorResult(visibilityNotAcknowledgedMessage(result));
        }
      }),
  );

  server.registerTool(
    "delete_folder",
    {
      description:
        "Delete an empty folder. A folder that still has pages or folders in it cannot be deleted; " +
        "move or delete its contents first. Pages in the trash do not count: when the folder is deleted, " +
        "they move to the top level of the space.",
      inputSchema: { folder_id: z.string().describe("The id of a folder returned by list_folders") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ folder_id }) =>
      guard("delete_folder", async () => {
        const result = await deleteFolder(db, user, folder_id);
        if (result.ok) return jsonResult({ id: folder_id, deleted: true });
        if (result.error === "not_found") return errorResult(folderNotFoundMessage);
        if (result.error === "space_archived") return errorResult(spaceArchivedMessage);
        return errorResult(folderNotEmptyMessage);
      }),
  );
}
