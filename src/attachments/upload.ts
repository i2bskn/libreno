import type { Db } from "@i2bskn/workers-app-core";
import type { AttachmentRow, UserRow } from "../db/schema";
import { createAttachment } from "./service";
import {
  ATTACHMENT_MAX_BYTES,
  checkAttachmentContent,
  detectContentType,
  withAttachmentExtension,
  type AttachmentContentType,
} from "./validation";

// The body of POST /api/v1/pages/:id/attachments (in pages.ts). With Content-Length, the body goes to R2 as
// a stream: only its first bytes are read in JS, to decide the type, which keeps the CPU time of large
// files low. Without it (e.g. chunked), the body has already been read by attachmentBodyLimit, which counts
// the bytes, and is checked as bytes, as MCP does.

// detectContentType needs at most the first 12 bytes (WebP).
const HEAD_BYTES = 12;

export type UploadPath = "stream" | "buffer";

// The same condition as hono's bodyLimit, which reads the body only when this is "buffer". The two must
// agree: a body read by bodyLimit has no Content-Length left to check the stream against.
export function chooseUploadPath(headers: Headers): UploadPath {
  return headers.has("content-length") && !headers.has("transfer-encoding") ? "stream" : "buffer";
}

// Digits only, after trimming: parseInt in bodyLimit takes "12abc" as 12. Returns null otherwise.
function parseContentLength(value: string | null): number | null {
  const trimmed = (value ?? "").trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

// Reads chunks until there are at least minBytes or the stream ends, then cancels the reader. Pass one
// branch of tee(): the chunks read are kept for the other branch until it is read.
export async function readHead(stream: ReadableStream<Uint8Array>, minBytes: number): Promise<{ head: Uint8Array }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < minBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.byteLength;
    }
  } finally {
    // cancel() rejects on a stream that has errored, which must not replace the error of read().
    await reader.cancel().catch(() => {});
  }
  if (chunks.length === 1 && chunks[0]) return { head: chunks[0] };
  const head = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    head.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { head };
}

export type ReceiveUploadResult =
  | { ok: true; attachment: AttachmentRow }
  | {
      ok: false;
      error: "empty_file" | "file_too_large" | "unsupported_type" | "upload_failed" | "not_found" | "space_archived";
    };

// Checks the size, then the type, then attaches the body of request to the page. filename is normalized,
// without the extension. The errors come in the same order on both paths; the page is checked last, by
// createAttachment.
export async function receiveUpload(
  db: Db,
  bucket: R2Bucket,
  user: UserRow,
  pageId: string,
  filename: string,
  request: Request,
): Promise<ReceiveUploadResult> {
  if (chooseUploadPath(request.headers) === "buffer") {
    const bytes = new Uint8Array(await request.arrayBuffer());
    const checked = checkAttachmentContent(bytes, ATTACHMENT_MAX_BYTES);
    if (!checked.ok) return checked;
    return createAttachment(db, bucket, user, pageId, {
      filename: withAttachmentExtension(filename, checked.contentType),
      contentType: checked.contentType,
      content: { kind: "bytes", bytes },
    });
  }

  const length = parseContentLength(request.headers.get("content-length"));
  if (length === null) return { ok: false, error: "upload_failed" };
  if (length === 0) return { ok: false, error: "empty_file" };
  // Usually rejected by bodyLimit already.
  if (length > ATTACHMENT_MAX_BYTES) return { ok: false, error: "file_too_large" };
  const body = request.body;
  if (!body) return { ok: false, error: "upload_failed" };

  // FixedLengthStream makes the put fail when the body is not of the length in Content-Length, and gives the
  // stream the known length that R2 requires; a branch of tee() of it keeps that length. It comes before
  // tee(): workerd cannot pipe a branch of the request body into it ("Inter-TransformStream
  // ReadableStream.pipeTo() is not implemented", and the put never ends).
  const [head, rest] = body.pipeThrough(new FixedLengthStream(length)).tee();
  // cancel() of rest below: see readHead. The stream passed to createAttachment is canceled there if needed.
  let contentType: AttachmentContentType | null;
  try {
    contentType = detectContentType((await readHead(head, HEAD_BYTES)).head);
  } catch {
    await rest.cancel().catch(() => {});
    return { ok: false, error: "upload_failed" };
  }
  if (contentType === null) {
    await rest.cancel().catch(() => {});
    return { ok: false, error: "unsupported_type" };
  }
  return createAttachment(db, bucket, user, pageId, {
    filename: withAttachmentExtension(filename, contentType),
    contentType,
    content: { kind: "stream", stream: rest },
  });
}
