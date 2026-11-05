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
} from "../api/types";
import { escapeMarkdownText } from "../attachments/validation";
import type { AttachmentRow, FolderRow, PageRevisionRow, PageRow, SpaceRow } from "../db/schema";
import type { PageSummaryRow } from "../pages/queries";
import type { RevisionSummaryRow } from "../pages/revisions";
import type { SearchHitRow } from "../pages/search";
import { TRASH_RETENTION_MS, type TrashedPageRow } from "../pages/trash";

// The JSON body helpers and toApiUser come from @i2bskn/workers-app-core. Pass AppEnv as the third type argument of
// jsonBody, so that the c of the check functions is typed.
export { jsonBody, readJsonObject, toApiUser, type JsonCheck } from "@i2bskn/workers-app-core";

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
