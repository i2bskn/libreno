import { and, asc, eq, exists, isNull, sql } from "drizzle-orm";
import { clock, describeError, type Db } from "@i2bskn/workers-app-core";
import { isForeignKeyViolation } from "../db/errors";
import { attachments, pages, type AttachmentRow, type PageRow, type UserRow } from "../db/schema";
import { findAccessiblePage, findAccessiblePageIncludingTrash, findPageById } from "../pages/queries";
import type { SpaceViewer } from "../spaces/access";
import { isSpaceArchived, spaceNotArchived } from "../spaces/archive";
import { findSpaceById } from "../spaces/queries";
import type { AttachmentContentType } from "./validation";

// Shared by the REST API and the MCP tools. Input is validated by the callers (see validation.ts).
// An attachment belongs to a page and is accessible exactly when the page is: the page must not be in the
// trash, and the viewer must be able to access its space. It moves with the page, which it refers to only
// by page_id, and is deleted with the page by ON DELETE CASCADE. The object in R2 is deleted by the
// scheduled job (sweep.ts).

// The key of the object in R2 that holds the contents.
export function attachmentKey(id: string): string {
  return `attachments/${id}`;
}

// Deletes an object whose row was not written or was just deleted. A failure is only logged: the scheduled
// job deletes objects without a row.
async function deleteObject(bucket: R2Bucket, id: string): Promise<void> {
  try {
    await bucket.delete(attachmentKey(id));
  } catch (error) {
    console.error("attachment object delete failed", { id, ...describeError(error) });
  }
}

// The contents: bytes already read (MCP, and REST without Content-Length), or the request body, which is
// passed to R2 without being read in JS. R2 takes only a stream of a known length: the readable side of a
// FixedLengthStream, or a branch of tee() of it (see upload.ts).
export type AttachmentContent =
  | { kind: "bytes"; bytes: Uint8Array }
  | { kind: "stream"; stream: ReadableStream<Uint8Array> };

export type CreateAttachmentInput = {
  // Normalized, with the extension of contentType.
  filename: string;
  contentType: AttachmentContentType;
  content: AttachmentContent;
};

export type CreateAttachmentResult =
  | { ok: true; attachment: AttachmentRow }
  | { ok: false; error: "not_found" | "space_archived" };

// Checks the page and its space, then puts the contents in R2 under a new ID. Returns the error, without
// writing to R2, if the page is not accessible or its space is archived.
// A stream belongs to this function from the call: it is canceled unless it has been handed to R2.
async function putContent(
  db: Db,
  bucket: R2Bucket,
  user: UserRow,
  pageId: string,
  input: CreateAttachmentInput,
): Promise<
  { ok: true; page: PageRow; id: string; size: number } | { ok: false; error: "not_found" | "space_archived" }
> {
  const { content } = input;
  let handedOver = false;
  try {
    const found = await findAccessiblePageIncludingTrash(db, user, pageId);
    if (!found || found.page.deletedAt !== null) return { ok: false, error: "not_found" };
    const { page } = found;
    if (found.space.archivedAt !== null) return { ok: false, error: "space_archived" };
    const id = crypto.randomUUID();
    handedOver = true;
    const value = content.kind === "bytes" ? content.bytes : content.stream;
    const object = await bucket.put(attachmentKey(id), value, { httpMetadata: { contentType: input.contentType } });
    return { ok: true, page, id, size: content.kind === "bytes" ? content.bytes.byteLength : object.size };
  } finally {
    // cancel() rejects on a stream that has errored, which must not replace the result or the error.
    if (!handedOver && content.kind === "stream") await content.stream.cancel().catch(() => {});
  }
}

// Puts the contents in R2 first, then writes the row, so that there is never a row without an object.
// An object whose row is not written is deleted; one left by a Worker that stopped in between is deleted
// by the scheduled job.
export async function createAttachment(
  db: Db,
  bucket: R2Bucket,
  user: UserRow,
  pageId: string,
  input: CreateAttachmentInput,
): Promise<CreateAttachmentResult> {
  const put = await putContent(db, bucket, user, pageId, input);
  if (!put.ok) return put;
  const { page, id, size } = put;

  // One conditional INSERT ... SELECT, so that a page moved to the trash or to another space, or a space
  // archived, after the check above gets nothing. drizzle checks that the keys are those of the table, in
  // the same order.
  let attachment: AttachmentRow | undefined;
  try {
    attachment = await db
      .insert(attachments)
      .select(
        db
          .select({
            id: sql<string>`${id}`.as("id"),
            pageId: sql<string>`${page.id}`.as("page_id"),
            filename: sql<string>`${input.filename}`.as("filename"),
            contentType: sql<AttachmentContentType>`${input.contentType}`.as("content_type"),
            size: sql<number>`${size}`.as("size"),
            createdBy: sql<string>`${user.id}`.as("created_by"),
            createdAt: sql<number>`${clock.now()}`.as("created_at"),
          })
          .from(pages)
          .where(
            and(
              eq(pages.id, page.id),
              eq(pages.spaceId, page.spaceId),
              isNull(pages.deletedAt),
              spaceNotArchived(page.spaceId),
            ),
          ),
      )
      .returning()
      .get();
  } catch (error) {
    await deleteObject(bucket, id);
    // The page was deleted, or the user was deleted (the session ends with it), after the check above.
    if (isForeignKeyViolation(error)) return { ok: false, error: "not_found" };
    throw error;
  }
  if (attachment) {
    // Which path the contents took, to check the CPU time of each in production. No ID or name.
    console.log("attachment uploaded", { path: input.content.kind, size, contentType: input.contentType });
    return { ok: true, attachment };
  }
  await deleteObject(bucket, id);
  return attachmentWriteFailure(db, page);
}

// Reports why a conditional write on an attachment of the page changed no rows. Access is not checked
// again: the page was visible just before.
async function attachmentWriteFailure(
  db: Db,
  page: Pick<PageRow, "id" | "spaceId">,
): Promise<{ ok: false; error: "not_found" | "space_archived" }> {
  const current = await findPageById(db, page.id);
  if (!current || current.spaceId !== page.spaceId || current.deletedAt !== null) {
    return { ok: false, error: "not_found" };
  }
  if (await isSpaceArchived(db, page.spaceId)) return { ok: false, error: "space_archived" };
  return { ok: false, error: "not_found" };
}

export type ListAttachmentsResult = { ok: true; attachments: AttachmentRow[] } | { ok: false; error: "not_found" };

// Lists the attachments of the page, oldest first.
export async function listAttachments(db: Db, viewer: SpaceViewer, pageId: string): Promise<ListAttachmentsResult> {
  const page = await findAccessiblePage(db, viewer, pageId);
  if (!page) return { ok: false, error: "not_found" };
  const rows = await db
    .select()
    .from(attachments)
    .where(eq(attachments.pageId, page.id))
    .orderBy(asc(attachments.createdAt), asc(attachments.id))
    .all();
  return { ok: true, attachments: rows };
}

// Returns the attachment with its page only if the page is not in the trash and the viewer can access its
// space, otherwise null. Callers report null as missing so that the existence of the file is not revealed.
export async function findAccessibleAttachment(
  db: Db,
  viewer: SpaceViewer,
  id: string,
): Promise<{ attachment: AttachmentRow; page: PageRow } | null> {
  const attachment = await db.select().from(attachments).where(eq(attachments.id, id)).get();
  if (!attachment) return null;
  const page = await findAccessiblePage(db, viewer, attachment.pageId);
  if (!page) return null;
  return { attachment, page };
}

export type DeleteAttachmentResult = { ok: true } | { ok: false; error: "not_found" | "space_archived" };

// Deletes the attachment and its object. Everyone who can edit the page can. There is no trash: this
// cannot be undone. Pages that refer to it in their bodies keep the reference, which no longer shows.
export async function deleteAttachment(
  db: Db,
  bucket: R2Bucket,
  viewer: SpaceViewer,
  id: string,
): Promise<DeleteAttachmentResult> {
  const found = await findAccessibleAttachment(db, viewer, id);
  if (!found) return { ok: false, error: "not_found" };
  const { attachment, page } = found;
  // Not in findAccessibleAttachment, which the reads share: archived spaces can still be read.
  const space = await findSpaceById(db, page.spaceId);
  if (!space) return { ok: false, error: "not_found" };
  if (space.archivedAt !== null) return { ok: false, error: "space_archived" };
  // The page must still be out of the trash and in the space whose access was just checked, and the space
  // must not be archived.
  const deleted = await db
    .delete(attachments)
    .where(
      and(
        eq(attachments.id, attachment.id),
        eq(attachments.pageId, page.id),
        exists(
          db
            .select({ id: pages.id })
            .from(pages)
            .where(
              and(
                eq(pages.id, page.id),
                eq(pages.spaceId, page.spaceId),
                isNull(pages.deletedAt),
                spaceNotArchived(page.spaceId),
              ),
            ),
        ),
      ),
    )
    .returning({ id: attachments.id })
    .get();
  // Also not_found when the attachment itself was deleted after the check above.
  if (!deleted) return attachmentWriteFailure(db, page);
  await deleteObject(bucket, attachment.id);
  return { ok: true };
}
