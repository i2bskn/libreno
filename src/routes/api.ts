import type { Context, MiddlewareHandler } from "hono";
import type {
  Attachment,
  Folder,
  Page,
  PageRevision,
  PageRevisionSummary,
  PageSummary,
  SearchHit,
  Space,
  TrashedPage,
  User,
} from "../api/types";
import { escapeMarkdownText } from "../attachments/validation";
import type { AttachmentRow, FolderRow, PageRevisionRow, PageRow, SpaceRow, UserRow } from "../db/schema";
import type { PageSummaryRow } from "../pages/queries";
import type { RevisionSummaryRow } from "../pages/revisions";
import type { SearchHitRow } from "../pages/search";
import { TRASH_RETENTION_MS, type TrashedPageRow } from "../pages/trash";
import type { AppEnv } from "../env";
import { apiError } from "../auth/middleware";
import { isJsonObject } from "../auth/validate";

export function toApiUser(user: UserRow): User {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    created_at: user.createdAt,
    last_login_at: user.lastLoginAt,
  };
}

export function toApiSpace(space: SpaceRow): Space {
  return {
    id: space.id,
    kind: space.kind,
    name: space.name,
    sort_order: space.sortOrder,
    archived_at: space.archivedAt,
    created_at: space.createdAt,
    updated_at: space.updatedAt,
  };
}

export function toApiFolder(folder: FolderRow): Folder {
  return {
    id: folder.id,
    space_id: folder.spaceId,
    parent_id: folder.parentId,
    name: folder.name,
    created_by: folder.createdBy,
    updated_by: folder.updatedBy,
    created_at: folder.createdAt,
    updated_at: folder.updatedAt,
  };
}

// Takes a row without the body so that page lists never need to read bodies from the DB.
export function toApiPageSummary(page: PageSummaryRow): PageSummary {
  return {
    id: page.id,
    space_id: page.spaceId,
    folder_id: page.folderId,
    title: page.title,
    version: page.version,
    created_by: page.createdBy,
    updated_by: page.updatedBy,
    created_at: page.createdAt,
    updated_at: page.updatedAt,
  };
}

export function toApiPage(page: PageRow): Page {
  return { ...toApiPageSummary(page), body: page.body };
}

export function toApiTrashedPage(page: TrashedPageRow): TrashedPage {
  if (page.deletedAt === null) throw new Error("unreachable: a page in the trash has deleted_at");
  return {
    ...toApiPageSummary(page),
    deleted_at: page.deletedAt,
    deleted_by: page.deletedBy,
    purge_after: page.deletedAt + TRASH_RETENTION_MS,
  };
}

export function toApiPageRevisionSummary(revision: RevisionSummaryRow): PageRevisionSummary {
  return {
    version: revision.version,
    title: revision.title,
    created_by: revision.createdBy,
    created_at: revision.createdAt,
  };
}

export function toApiPageRevision(revision: PageRevisionRow): PageRevision {
  return {
    page_id: revision.pageId,
    version: revision.version,
    title: revision.title,
    created_by: revision.createdBy,
    created_at: revision.createdAt,
    body: revision.body,
  };
}

export function toApiSearchHit(hit: SearchHitRow): SearchHit {
  return { ...toApiPageSummary(hit), snippet: hit.snippet };
}

export function toApiAttachment(attachment: AttachmentRow): Attachment {
  const url = `/api/v1/attachments/${attachment.id}`;
  const text = escapeMarkdownText(attachment.filename);
  const markdown = attachment.contentType === "application/pdf" ? `[${text}](${url})` : `![${text}](${url})`;
  return {
    id: attachment.id,
    page_id: attachment.pageId,
    filename: attachment.filename,
    content_type: attachment.contentType,
    size: attachment.size,
    created_by: attachment.createdBy,
    created_at: attachment.createdAt,
    url,
    markdown,
  };
}

// Returns the JSON body if it is an object, otherwise null.
export async function readJsonObject(c: Context<AppEnv>): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return isJsonObject(body) ? body : null;
  } catch {
    return null;
  }
}

export type JsonCheck<Out> = (
  body: Record<string, unknown>,
  c: Context<AppEnv>,
) => { ok: true; value: Out } | Response;

// Validates the JSON body and passes the result to c.req.valid("json").
// Reads the body regardless of Content-Type, and returns the error response from check as is.
export function jsonBody<In, Out extends object>(
  check: JsonCheck<Out>,
): MiddlewareHandler<AppEnv, string, { in: { json: In }; out: { json: Out } }> {
  return async (c, next) => {
    const body = await readJsonObject(c);
    if (!body) return apiError(c, 400, "invalid_body", "リクエストの形式が正しくありません");
    const result = check(body, c);
    if (result instanceof Response) return result;
    c.req.addValidatedData("json", result.value);
    return next();
  };
}
