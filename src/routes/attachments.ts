import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../env";
import { apiError } from "@i2bskn/workers-app-core";
import { core } from "../core";
import { attachmentKey, deleteAttachment, findAccessibleAttachment } from "../attachments/service";
import {
  ATTACHMENT_MAX_BYTES,
  attachmentNotFoundMessage,
  fileTooLargeMessage,
  invalidFilenameMessage,
  normalizeAttachmentFilename,
} from "../attachments/validation";
import type { AttachmentRow } from "../db/schema";
import { spaceArchivedMessage } from "../spaces/archive";

const { requireUser } = core.middleware;

// The middleware of POST /api/v1/pages/:id/attachments (in pages.ts).

// Validates ?filename= and passes the normalized name (without the extension check, which needs the type) to
// c.req.valid("query"). Not validator("query"), which turns repeated keys into arrays; c.req.query() takes
// the first value, as in search.ts.
export const attachmentFilenameQuery: MiddlewareHandler<
  AppEnv,
  string,
  { in: { query: { filename: string } }; out: { query: { filename: string } } }
> = async (c, next) => {
  const filename = normalizeAttachmentFilename(c.req.query("filename"));
  if (filename === null) return apiError(c, 400, "invalid_filename", invalidFilenameMessage);
  c.req.addValidatedData("query", { filename });
  return next();
};

// The body is the file itself. Without Content-Length (e.g. chunked), bodyLimit counts the bytes as it reads.
export const attachmentBodyLimit = bodyLimit({
  maxSize: ATTACHMENT_MAX_BYTES,
  onError: (c) => apiError(c, 413, "file_too_large", fileTooLargeMessage),
});

// RFC 6266: a quoted ASCII name for old clients, and the UTF-8 name in filename*. encodeURIComponent leaves
// ' ( ) * as they are, which are not allowed in filename*.
function contentDisposition(attachment: AttachmentRow): string {
  // Images are shown in <img> and in the browser. PDF is downloaded: whether the PDF viewers of browsers work
  // under the sandbox CSP below is not known.
  const type = attachment.contentType === "application/pdf" ? "attachment" : "inline";
  const ascii = attachment.filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(attachment.filename).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

const attachmentsApi = new Hono<AppEnv>()
  // The contents. Read with the session cookie, also by <img> in page bodies.
  .get("/:id", requireUser, async (c) => {
    const found = await findAccessibleAttachment(c.get("db"), c.get("user"), c.req.param("id"));
    if (!found) return apiError(c, 404, "not_found", attachmentNotFoundMessage);
    const { attachment } = found;
    const object = await c.env.ATTACHMENTS.get(attachmentKey(attachment.id));
    if (!object) {
      // Happens when the attachment is deleted between the two reads.
      console.warn("attachment object missing", { id: attachment.id });
      return apiError(c, 404, "not_found", attachmentNotFoundMessage);
    }
    return c.body(object.body, 200, {
      "Content-Type": attachment.contentType,
      "Content-Length": String(object.size),
      "Content-Disposition": contentDisposition(attachment),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
      // Kept by securityHeaders, which sets no-store on the rest of /api/v1. A file deleted or moved out of
      // reach may still be read from the browser cache for up to 5 minutes.
      "Cache-Control": "private, max-age=300",
    });
  })
  // Deletes the attachment and its contents. This cannot be undone.
  .delete("/:id", requireUser, async (c) => {
    const result = await deleteAttachment(c.get("db"), c.env.ATTACHMENTS, c.get("user"), c.req.param("id"));
    if (!result.ok && result.error === "space_archived") return apiError(c, 409, "space_archived", spaceArchivedMessage);
    if (!result.ok) return apiError(c, 404, "not_found", attachmentNotFoundMessage);
    return c.body(null, 204);
  });

export default attachmentsApi;
