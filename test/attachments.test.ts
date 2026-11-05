import { createExecutionContext, createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Attachment, AttachmentList } from "../src/api/types";
import {
  attachmentKey,
  createAttachment,
  deleteAttachment,
  type AttachmentContent,
} from "../src/attachments/service";
import { sweepOrphanAttachments } from "../src/attachments/sweep";
import { chooseUploadPath, readHead, receiveUpload } from "../src/attachments/upload";
import {
  ATTACHMENT_MAX_BYTES,
  decodeBase64,
  detectContentType,
  normalizeAttachmentFilename,
  withAttachmentExtension,
} from "../src/attachments/validation";
import { clock, createDb, type Db } from "@i2bskn/workers-app-core";
import { attachments, pages, spaces, type SpaceRow, type UserRow } from "../src/db/schema";
import worker from "../src/index";
import {
  appDb,
  createUser,
  db,
  insertPage,
  login,
  resetAttachments,
  resetDb,
  send,
  type SessionCookies,
} from "./helpers";

const T0 = Date.UTC(2026, 9, 1);
const DAY = 24 * 60 * 60 * 1000;

const PNG = bytesOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG = bytesOf([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF87A = new TextEncoder().encode("GIF87a\x01\x00");
const GIF89A = new TextEncoder().encode("GIF89a\x01\x00");
const WEBP = new TextEncoder().encode("RIFF\x24\x00\x00\x00WEBPVP8 ");
const PDF = new TextEncoder().encode("%PDF-1.7\n%\n");

function bytesOf(values: number[]): Uint8Array {
  return new Uint8Array(values);
}

// A file of the given size that starts with the signature of PNG.
function pngOfSize(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(PNG.subarray(0, Math.min(PNG.byteLength, size)));
  return bytes;
}

// The bytes as a stream of chunks of chunkSize, as a body arrives over the network. calls counts what the
// reader did.
function streamOf(
  bytes: Uint8Array,
  chunkSize = bytes.byteLength,
  calls: { pulls: number; canceled: boolean } = { pulls: 0, canceled: false },
): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      calls.pulls++;
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
    cancel() {
      calls.canceled = true;
    },
  });
}

// The stream of a known length that createAttachment takes, as receiveUpload makes it.
function fixedLength(stream: ReadableStream<Uint8Array>, length: number): ReadableStream<Uint8Array> {
  return stream.pipeThrough(new FixedLengthStream(length));
}

// A stream whose first read fails, as when the client goes away.
function failingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error("connection lost"));
    },
  });
}

function setNow(now: number) {
  vi.spyOn(clock, "now").mockReturnValue(now);
}

async function insertSpace(kind: "everyone" | "admin", name: string): Promise<SpaceRow> {
  const [space] = await db
    .insert(spaces)
    .values({ id: crypto.randomUUID(), kind, name, createdAt: T0, updatedAt: T0 })
    .returning();
  if (!space) throw new Error("failed to create space");
  return space;
}

async function personalSpaceOf(user: UserRow): Promise<SpaceRow> {
  const space = await db.query.spaces.findFirst({ where: eq(spaces.ownerUserId, user.id) });
  if (!space) throw new Error("personal space not found");
  return space;
}

async function errorOf(res: Response): Promise<{ code: string; message: string }> {
  return ((await res.json()) as { error: { code: string; message: string } }).error;
}

function upload(pageId: string, cookies: SessionCookies, body: BodyInit, filename: string | null = "file"): Promise<Response> {
  const query = filename === null ? "" : `?filename=${encodeURIComponent(filename)}`;
  return send(`/api/v1/pages/${pageId}/attachments${query}`, { cookies, body });
}

// Sends Content-Length explicitly: a Request built in workerd does not add it from the body, so upload()
// takes the path without it (see attachments/upload.ts). workerd keeps a Content-Length set by hand, and
// does not check it against the body.
function uploadWithLength(
  pageId: string,
  cookies: SessionCookies,
  body: BodyInit,
  length: number | string,
  filename = "file",
): Promise<Response> {
  return send(`/api/v1/pages/${pageId}/attachments?filename=${encodeURIComponent(filename)}`, {
    cookies,
    body,
    headers: { "Content-Length": String(length) },
  });
}

function spyOnUploadLog() {
  return vi.spyOn(console, "log").mockImplementation(() => {});
}

async function uploadOk(pageId: string, cookies: SessionCookies, body: Uint8Array, filename = "file"): Promise<Attachment> {
  const res = await upload(pageId, cookies, body, filename);
  expect(res.status).toBe(201);
  return (await res.json()) as Attachment;
}

function getContents(id: string, cookies: SessionCookies): Promise<Response> {
  return send(`/api/v1/attachments/${id}`, { cookies });
}

function deleteAttachmentRequest(id: string, cookies: SessionCookies): Promise<Response> {
  return send(`/api/v1/attachments/${id}`, { method: "DELETE", cookies });
}

async function objectKeys(): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const listed = await env.ATTACHMENTS.list({ cursor });
    keys.push(...listed.objects.map((object) => object.key));
    if (!listed.truncated) return keys.sort();
    cursor = listed.cursor;
  }
}

async function countAttachmentRows(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM attachments").first<{ count: number }>();
  return row?.count ?? 0;
}

// The same as in move.test.ts: a Db whose D1 binding runs before() once, right before the first statement
// matching pattern runs, as if another request changed the data between the checks of a service and its write.
function dbChangingBefore(pattern: RegExp, before: () => Promise<unknown>): Db {
  const real = env.DB;
  let done = false;
  async function runBefore() {
    if (done) return;
    done = true;
    await before();
  }
  const d1 = new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          if (!pattern.test(query)) return statement;
          return {
            bind: (...values: unknown[]) => {
              const bound = statement.bind(...values);
              return {
                all: async () => (await runBefore(), bound.all()),
                raw: async () => (await runBefore(), bound.raw()),
                run: async () => (await runBefore(), bound.run()),
                first: async () => (await runBefore(), bound.first()),
              };
            },
          };
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return createDb(d1);
}

let admin: UserRow;
let member: UserRow;
let adminCookies: SessionCookies;
let memberCookies: SessionCookies;
let everyone: SpaceRow;

beforeEach(async () => {
  await resetDb();
  await resetAttachments();
  setNow(T0);
  admin = await createUser({ email: "admin@example.com", role: "admin", createdAt: T0 });
  member = await createUser({ email: "member@example.com", role: "member", createdAt: T0 });
  adminCookies = await login(admin.email);
  memberCookies = await login(member.email);
  everyone = await insertSpace("everyone", "Everyone");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("validation", () => {
  it.each([
    ["PNG", PNG, "image/png"],
    ["JPEG", JPEG, "image/jpeg"],
    ["GIF87a", GIF87A, "image/gif"],
    ["GIF89a", GIF89A, "image/gif"],
    ["WebP", WEBP, "image/webp"],
    ["PDF", PDF, "application/pdf"],
  ])("detects %s from the first bytes", (_, bytes, type) => {
    expect(detectContentType(bytes)).toBe(type);
  });

  it.each([
    ["SVG", new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ["HTML", new TextEncoder().encode("<!doctype html><script>alert(1)</script>")],
    ["an exe", new TextEncoder().encode("MZ\x90\x00")],
    ["GIF88a", new TextEncoder().encode("GIF88a\x01\x00")],
    ["RIFF without WEBP", new TextEncoder().encode("RIFF\x24\x00\x00\x00WAVEfmt ")],
    ["a truncated PNG signature", PNG.subarray(0, 7)],
    ["a truncated WebP header", WEBP.subarray(0, 11)],
    ["one byte", bytesOf([0xff])],
    ["no bytes", new Uint8Array()],
  ])("detects nothing for %s", (_, bytes) => {
    expect(detectContentType(bytes)).toBeNull();
  });

  it.each([
    ["  report.pdf  ", "report.pdf"],
    ["dir/sub\\name", "dir_sub_name"],
    ["a\u0000b\nc", "abc"],
    ["evil‮fdp.exe", "evilfdp.exe"],
    ["​zero", "zero"],
    ["name. . .", "name"],
    ["a.", "a"],
    ["日本語の名前", "日本語の名前"],
  ])("normalizes %j to %j", (value, expected) => {
    expect(normalizeAttachmentFilename(value)).toBe(expected);
  });

  it.each([
    ["an empty name", ""],
    ["whitespace", "   "],
    ["dots", "..."],
    ["control characters only", "\u0000\u0001"],
    ["251 characters", "a".repeat(251)],
    ["a lone surrogate", "a\uD800"],
    ["not a string", undefined],
  ])("rejects %s", (_, value) => {
    expect(normalizeAttachmentFilename(value)).toBeNull();
  });

  it("accepts 250 characters, counted in code points", () => {
    expect(normalizeAttachmentFilename("a".repeat(250))).toBe("a".repeat(250));
    expect(normalizeAttachmentFilename("😀".repeat(250))).toBe("😀".repeat(250));
    expect(normalizeAttachmentFilename("😀".repeat(251))).toBeNull();
  });

  it.each([
    ["x.hta", "application/pdf", "x.hta.pdf"],
    ["photo", "image/png", "photo.png"],
    ["a.JPEG", "image/jpeg", "a.JPEG"],
    ["a.jpg", "image/jpeg", "a.jpg"],
    ["a.png", "image/jpeg", "a.png.jpg"],
    ["a.Gif", "image/gif", "a.Gif"],
    ["a.webp", "image/webp", "a.webp"],
    [".pdf", "application/pdf", ".pdf"],
  ] as const)("names %j of %s %j", (name, type, expected) => {
    expect(withAttachmentExtension(name, type)).toBe(expected);
  });

  it("keeps a name of 250 characters within 255 with the extension", () => {
    const name = normalizeAttachmentFilename("a".repeat(250));
    expect(withAttachmentExtension(name ?? "", "image/webp")).toHaveLength(255);
  });

  it("decodes base64 with whitespace and line breaks", () => {
    expect(decodeBase64("aGVs\nbG8g\r\nd29y bGQ=")).toEqual(new TextEncoder().encode("hello world"));
    expect(decodeBase64("")).toEqual(new Uint8Array());
  });

  it.each([["base64url", "-_-_"], ["other characters", "aGVsbG8*"], ["a broken length", "aGVsbG8gd"]])(
    "does not decode %s",
    (_, value) => {
      expect(decodeBase64(value)).toBeNull();
    },
  );
});

describe("REST API", () => {
  it("uploads, lists, serves and deletes an attachment", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const created = await uploadOk(page.id, memberCookies, PNG, "screen shot");
    expect(created).toEqual({
      id: created.id,
      page_id: page.id,
      filename: "screen shot.png",
      content_type: "image/png",
      size: PNG.byteLength,
      created_by: member.id,
      created_at: T0,
      url: `/api/v1/attachments/${created.id}`,
      markdown: `![screen shot.png](/api/v1/attachments/${created.id})`,
    });
    expect(await objectKeys()).toEqual([attachmentKey(created.id)]);
    const object = await env.ATTACHMENTS.get(attachmentKey(created.id));
    expect(object?.httpMetadata?.contentType).toBe("image/png");

    const list = await send(`/api/v1/pages/${page.id}/attachments`, { cookies: adminCookies });
    expect(list.status).toBe(200);
    expect(((await list.json()) as AttachmentList).attachments).toEqual([created]);

    const contents = await getContents(created.id, adminCookies);
    expect(contents.status).toBe(200);
    expect(new Uint8Array(await contents.arrayBuffer())).toEqual(PNG);

    const deleted = await deleteAttachmentRequest(created.id, adminCookies);
    expect(deleted.status).toBe(204);
    expect(await getContents(created.id, adminCookies)).toHaveProperty("status", 404);
    expect(await objectKeys()).toEqual([]);
    expect(await countAttachmentRows()).toBe(0);
    expect((await deleteAttachmentRequest(created.id, adminCookies)).status).toBe(404);
  });

  it("lists the attachments oldest first", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const first = await uploadOk(page.id, memberCookies, PNG, "first");
    setNow(T0 + 1000);
    const second = await uploadOk(page.id, memberCookies, PDF, "second");
    const res = await send(`/api/v1/pages/${page.id}/attachments`, { cookies: memberCookies });
    const body = (await res.json()) as AttachmentList;
    expect(body.attachments.map((a) => a.id)).toEqual([first.id, second.id]);
  });

  it("serves an image inline with the headers that keep it from running anything", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const created = await uploadOk(page.id, memberCookies, PNG, "写真 \"1\".png");
    const res = await getContents(created.id, memberCookies);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Content-Length")).toBe(String(PNG.byteLength));
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=300");
    expect(res.headers.get("Content-Disposition")).toBe(
      `inline; filename="__ _1_.png"; filename*=UTF-8''${encodeURIComponent("写真 \"1\".png")}`,
    );
    await res.arrayBuffer();

    // The rest of /api/v1 stays no-store, also on errors.
    const pageRes = await send(`/api/v1/pages/${page.id}`, { cookies: memberCookies });
    expect(pageRes.headers.get("Cache-Control")).toBe("no-store");
    const listRes = await send(`/api/v1/pages/${page.id}/attachments`, { cookies: memberCookies });
    expect(listRes.headers.get("Cache-Control")).toBe("no-store");
    const missing = await getContents(crypto.randomUUID(), memberCookies);
    expect(missing.headers.get("Cache-Control")).toBe("no-store");
  });

  it("serves a PDF as a download and encodes the characters that filename* does not allow", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const created = await uploadOk(page.id, memberCookies, PDF, "it's (1)*.pdf");
    const res = await getContents(created.id, memberCookies);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="it's (1)*.pdf"; filename*=UTF-8''it%27s%20%281%29%2A.pdf`,
    );
    expect(created.markdown).toBe(`[it's (1)\\*.pdf](/api/v1/attachments/${created.id})`);
    await res.arrayBuffer();
  });

  it("escapes the Markdown characters in the name", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    // "\\" in the name has become "_".
    const created = await uploadOk(page.id, memberCookies, PNG, "a\\b`c*d_e[f]<g>.png");
    expect(created.markdown).toBe(`![a\\_b\\\`c\\*d\\_e\\[f\\]\\<g\\>.png](/api/v1/attachments/${created.id})`);
  });

  it("decides the type from the contents and fixes the extension", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    expect((await uploadOk(page.id, memberCookies, PDF, "x.hta")).filename).toBe("x.hta.pdf");
    expect((await uploadOk(page.id, memberCookies, JPEG, "a.JPEG")).filename).toBe("a.JPEG");
    expect((await uploadOk(page.id, memberCookies, PNG, "a.")).filename).toBe("a.png");
    expect((await uploadOk(page.id, memberCookies, GIF89A, "dir/anim")).filename).toBe("dir_anim.gif");
    expect((await uploadOk(page.id, memberCookies, WEBP, "evil‮gpj.exe")).filename).toBe("evilgpj.exe.webp");
  });

  it("accepts a body without Content-Length", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(PNG.subarray(0, 4));
        controller.enqueue(PNG.subarray(4));
        controller.close();
      },
    });
    const log = spyOnUploadLog();
    const res = await upload(page.id, memberCookies, body, "stream");
    expect(res.status).toBe(201);
    expect(((await res.json()) as Attachment).size).toBe(PNG.byteLength);
    expect(log).toHaveBeenCalledWith("attachment uploaded", { path: "bytes", size: PNG.byteLength, contentType: "image/png" });
  });

  it("accepts exactly 10MB and rejects more with 413", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    expect((await uploadOk(page.id, memberCookies, pngOfSize(ATTACHMENT_MAX_BYTES))).size).toBe(ATTACHMENT_MAX_BYTES);
    const res = await upload(page.id, memberCookies, pngOfSize(ATTACHMENT_MAX_BYTES + 1));
    expect(res.status).toBe(413);
    expect(await errorOf(res)).toEqual({ code: "file_too_large", message: "添付できるファイルは 10MB までです" });
  });

  it("rejects more than 10MB without Content-Length", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const chunk = pngOfSize(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > ATTACHMENT_MAX_BYTES) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        sent += chunk.byteLength;
      },
    });
    const res = await upload(page.id, memberCookies, body);
    expect(res.status).toBe(413);
    expect((await errorOf(res)).code).toBe("file_too_large");
    expect(await countAttachmentRows()).toBe(0);
  });

  it.each([
    ["an empty file", new Uint8Array(), 400, "empty_file", "空のファイルは添付できません"],
    [
      "SVG",
      new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      400,
      "unsupported_type",
      "添付できるのは PNG・JPEG・GIF・WebP の画像と PDF です",
    ],
    [
      "HTML",
      new TextEncoder().encode("<!doctype html>"),
      400,
      "unsupported_type",
      "添付できるのは PNG・JPEG・GIF・WebP の画像と PDF です",
    ],
    ["text named .png", new TextEncoder().encode("hello"), 400, "unsupported_type", "添付できるのは PNG・JPEG・GIF・WebP の画像と PDF です"],
  ])("rejects %s", async (_, body, status, code, message) => {
    const page = await insertPage({ spaceId: everyone.id });
    const res = await upload(page.id, memberCookies, body, "file.png");
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toEqual({ code, message });
    expect(await objectKeys()).toEqual([]);
  });

  it.each([
    ["no filename", null],
    ["an empty filename", ""],
    ["a blank filename", "  "],
    ["251 characters", "a".repeat(251)],
  ])("rejects %s before reading the body", async (_, filename) => {
    const page = await insertPage({ spaceId: everyone.id });
    const res = await upload(page.id, memberCookies, new TextEncoder().encode("not a file"), filename);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toEqual({
      code: "invalid_filename",
      message: "ファイル名は 1 文字以上 250 文字以下にしてください",
    });
  });

  it("takes the first filename when it is repeated, as search does", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const res = await send(`/api/v1/pages/${page.id}/attachments?filename=first&filename=second`, {
      cookies: memberCookies,
      body: PNG,
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Attachment).filename).toBe("first.png");
  });

  it("accepts 250 characters and adds the extension", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const created = await uploadOk(page.id, memberCookies, PNG, "a".repeat(250));
    expect(created.filename).toBe(`${"a".repeat(250)}.png`);
  });

  it("requires a login", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const created = await uploadOk(page.id, memberCookies, PNG);
    expect((await upload(page.id, {} as SessionCookies, PNG)).status).toBe(401);
    expect((await send(`/api/v1/attachments/${created.id}`)).status).toBe(401);
  });

  it("rejects an upload from another origin", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const res = await send(`/api/v1/pages/${page.id}/attachments?filename=x`, {
      cookies: memberCookies,
      body: PNG,
      origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
    expect(await objectKeys()).toEqual([]);
  });
});

describe("upload with Content-Length", () => {
  // The path of browsers: the body goes to R2 as a stream (see attachments/upload.ts). Every test checks the
  // log of the path, so that none of them passes through the path without Content-Length unnoticed.

  it.each([
    ["PNG", PNG, "image/png"],
    ["PDF", PDF, "application/pdf"],
  ])("uploads %s as a stream and serves the same bytes", async (_, bytes, contentType) => {
    const page = await insertPage({ spaceId: everyone.id });
    const log = spyOnUploadLog();
    const res = await uploadWithLength(page.id, memberCookies, bytes, bytes.byteLength);
    expect(res.status).toBe(201);
    const created = (await res.json()) as Attachment;
    expect(created.size).toBe(bytes.byteLength);
    expect(created.content_type).toBe(contentType);
    expect(log).toHaveBeenCalledWith("attachment uploaded", { path: "stream", size: bytes.byteLength, contentType });
    expect((await env.ATTACHMENTS.get(attachmentKey(created.id)))?.httpMetadata?.contentType).toBe(contentType);
    const contents = await getContents(created.id, memberCookies);
    expect(new Uint8Array(await contents.arrayBuffer())).toEqual(bytes);
  });

  it.each([1, 5, 11])("decides the type from a body that arrives in chunks of %i bytes", async (chunkSize) => {
    const page = await insertPage({ spaceId: everyone.id });
    const log = spyOnUploadLog();
    const res = await uploadWithLength(page.id, memberCookies, streamOf(WEBP, chunkSize), WEBP.byteLength);
    expect(res.status).toBe(201);
    const created = (await res.json()) as Attachment;
    expect(created.content_type).toBe("image/webp");
    expect(log).toHaveBeenCalledWith("attachment uploaded", {
      path: "stream",
      size: WEBP.byteLength,
      contentType: "image/webp",
    });
    const contents = await getContents(created.id, memberCookies);
    expect(new Uint8Array(await contents.arrayBuffer())).toEqual(WEBP);
  });

  it("passes a large body through in chunks", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const bytes = pngOfSize(3 * 1024 * 1024 + 1);
    bytes[bytes.byteLength - 1] = 0x7f;
    const log = spyOnUploadLog();
    const res = await uploadWithLength(page.id, memberCookies, streamOf(bytes, 64 * 1024), bytes.byteLength);
    expect(res.status).toBe(201);
    const created = (await res.json()) as Attachment;
    expect(created.size).toBe(bytes.byteLength);
    expect(log).toHaveBeenCalledWith("attachment uploaded", { path: "stream", size: bytes.byteLength, contentType: "image/png" });
    const contents = await getContents(created.id, memberCookies);
    expect(new Uint8Array(await contents.arrayBuffer())).toEqual(bytes);
  });

  it("rejects a type it does not accept and leaves no object", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const log = spyOnUploadLog();
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const res = await uploadWithLength(page.id, memberCookies, streamOf(svg, 4), svg.byteLength);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toEqual({
      code: "unsupported_type",
      message: "添付できるのは PNG・JPEG・GIF・WebP の画像と PDF です",
    });
    expect(await objectKeys()).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it("rejects Content-Length 0 as an empty file", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const res = await uploadWithLength(page.id, memberCookies, new Uint8Array(), 0);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toEqual({ code: "empty_file", message: "空のファイルは添付できません" });
  });

  it("rejects a Content-Length over 10MB without reading the body", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const res = await uploadWithLength(page.id, memberCookies, PNG, ATTACHMENT_MAX_BYTES + 1);
    expect(res.status).toBe(413);
    expect((await errorOf(res)).code).toBe("file_too_large");
    expect(await objectKeys()).toEqual([]);
  });

  it("rejects a Content-Length that is not only digits", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    // bodyLimit reads it with parseInt as 12 and lets it through.
    const res = await uploadWithLength(page.id, memberCookies, PNG, "12abc");
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toEqual({ code: "upload_failed", message: "ファイルを受け取れませんでした" });
    expect(await objectKeys()).toEqual([]);
  });

  it("returns 404 for a page in the trash and leaves no object", async () => {
    const page = await insertPage({ spaceId: everyone.id, deletedAt: T0, deletedBy: member.id });
    const log = spyOnUploadLog();
    const res = await uploadWithLength(page.id, memberCookies, streamOf(PNG, 3), PNG.byteLength);
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toEqual({ code: "not_found", message: "ページが見つかりません" });
    expect(await objectKeys()).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("receiveUpload", () => {
  // Called directly, with headers that bodyLimit would not let through or that send() cannot make.

  function request(body: BodyInit | null, headers: Record<string, string>): Request {
    return new Request("https://example.com/", { method: "POST", body, headers });
  }

  function receive(req: Request, pageId: string) {
    return receiveUpload(appDb, env.ATTACHMENTS, member, pageId, "file", req);
  }

  it("streams a body with Content-Length", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const log = spyOnUploadLog();
    const result = await receive(request(streamOf(GIF89A, 2), { "Content-Length": String(GIF89A.byteLength) }), page.id);
    expect(result).toMatchObject({ ok: true, attachment: { filename: "file.gif", size: GIF89A.byteLength } });
    expect(log).toHaveBeenCalledWith("attachment uploaded", {
      path: "stream",
      size: GIF89A.byteLength,
      contentType: "image/gif",
    });
  });

  it.each([
    ["a Content-Length over 10MB", { "Content-Length": String(ATTACHMENT_MAX_BYTES + 1) }, "file_too_large"],
    ["Content-Length 0", { "Content-Length": "0" }, "empty_file"],
    ["Content-Length with letters", { "Content-Length": "12abc" }, "upload_failed"],
    ["a negative Content-Length", { "Content-Length": "-1" }, "upload_failed"],
    ["a blank Content-Length", { "Content-Length": " " }, "upload_failed"],
  ])("rejects %s", async (_, headers, error) => {
    const page = await insertPage({ spaceId: everyone.id });
    expect(await receive(request(PNG, headers), page.id)).toEqual({ ok: false, error });
    expect(await objectKeys()).toEqual([]);
  });

  it("accepts Content-Length with spaces around it", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const result = await receive(request(PNG, { "Content-Length": ` ${PNG.byteLength} ` }), page.id);
    expect(result).toMatchObject({ ok: true, attachment: { size: PNG.byteLength } });
  });

  it("fails without a body when Content-Length is not 0", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    expect(await receive(request(null, { "Content-Length": "12" }), page.id)).toEqual({ ok: false, error: "upload_failed" });
  });

  it("fails when the first bytes cannot be read, and leaves no object", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    expect(await receive(request(failingStream(), { "Content-Length": "12" }), page.id)).toEqual({
      ok: false,
      error: "upload_failed",
    });
    expect(await objectKeys()).toEqual([]);
  });

  it("rejects a type it does not accept", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const html = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
    // Whether the body is canceled cannot be seen here: workerd does not pass cancel() of the readable side
    // of a FixedLengthStream on to a stream made in JS.
    const result = await receive(request(streamOf(html, 4), { "Content-Length": String(html.byteLength) }), page.id);
    expect(result).toEqual({ ok: false, error: "unsupported_type" });
    expect(await objectKeys()).toEqual([]);
  });

  it("throws and writes nothing when the body is shorter than Content-Length", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const req = request(streamOf(PNG, 4), { "Content-Length": String(PNG.byteLength + 1) });
    await expect(receive(req, page.id)).rejects.toThrow();
    expect(await countAttachmentRows()).toBe(0);
    expect(await objectKeys()).toEqual([]);
  });

  it("reads the body as bytes with Transfer-Encoding, as bodyLimit does", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const log = spyOnUploadLog();
    const req = request(PNG, { "Content-Length": String(PNG.byteLength), "Transfer-Encoding": "chunked" });
    expect(await receive(req, page.id)).toMatchObject({ ok: true });
    expect(log).toHaveBeenCalledWith("attachment uploaded", { path: "bytes", size: PNG.byteLength, contentType: "image/png" });
  });

  it("chooses the path as bodyLimit does", () => {
    expect(chooseUploadPath(new Headers({ "Content-Length": "1" }))).toBe("stream");
    expect(chooseUploadPath(new Headers())).toBe("buffer");
    expect(chooseUploadPath(new Headers({ "Content-Length": "1", "Transfer-Encoding": "chunked" }))).toBe("buffer");
    expect(chooseUploadPath(new Headers({ "Transfer-Encoding": "chunked" }))).toBe("buffer");
  });
});

describe("readHead", () => {
  it("joins chunks until it has enough, then cancels the reader", async () => {
    const calls = { pulls: 0, canceled: false };
    const { head } = await readHead(streamOf(WEBP, 1, calls), 12);
    expect(head).toEqual(WEBP.subarray(0, 12));
    expect(calls.pulls).toBeLessThanOrEqual(13);
    expect(calls.canceled).toBe(true);
  });

  it("returns a first chunk that is long enough as it is", async () => {
    const { head } = await readHead(streamOf(PDF), 12);
    expect(head).toEqual(PDF);
  });

  it("returns what there is when the stream ends first", async () => {
    const { head } = await readHead(streamOf(JPEG, 2), 12);
    expect(head).toEqual(JPEG);
    expect((await readHead(streamOf(new Uint8Array()), 12)).head).toEqual(new Uint8Array());
  });

  it("rejects with the error of the stream", async () => {
    await expect(readHead(failingStream(), 12)).rejects.toThrow("connection lost");
  });
});

describe("createAttachment with a stream", () => {
  it("cancels the stream when the page is not found", async () => {
    const page = await insertPage({ spaceId: everyone.id, deletedAt: T0, deletedBy: member.id });
    const calls = { pulls: 0, canceled: false };
    const result = await createAttachment(appDb, env.ATTACHMENTS, member, page.id, {
      filename: "a.png",
      contentType: "image/png",
      content: { kind: "stream", stream: streamOf(PNG, 4, calls) },
    });
    expect(result).toEqual({ ok: false, error: "not_found" });
    expect(calls.canceled).toBe(true);
    expect(await objectKeys()).toEqual([]);
  });

  it("cancels the stream and rethrows when the page cannot be read", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const failing = dbChangingBefore(/^select .* from "pages"/i, () => Promise.reject(new Error("D1 is down")));
    const calls = { pulls: 0, canceled: false };
    await expect(
      createAttachment(failing, env.ATTACHMENTS, member, page.id, {
        filename: "a.png",
        contentType: "image/png",
        content: { kind: "stream", stream: streamOf(PNG, 4, calls) },
      }),
    ).rejects.toMatchObject({ cause: new Error("D1 is down") });
    expect(calls.canceled).toBe(true);
  });

  it("keeps the result when the stream cannot be canceled", async () => {
    const page = await insertPage({ spaceId: everyone.id, deletedAt: T0, deletedBy: member.id });
    const stream = failingStream();
    // Errored by the first read: cancel() rejects.
    const reader = stream.getReader();
    await reader.read().catch(() => {});
    reader.releaseLock();
    await expect(stream.cancel()).rejects.toThrow("connection lost");
    const result = await createAttachment(appDb, env.ATTACHMENTS, member, page.id, {
      filename: "a.png",
      contentType: "image/png",
      content: { kind: "stream", stream },
    });
    expect(result).toEqual({ ok: false, error: "not_found" });
  });
});

describe("access", () => {
  it("hides the attachments of another user's personal space", async () => {
    const own = await insertPage({ spaceId: (await personalSpaceOf(admin)).id });
    const created = await uploadOk(own.id, adminCookies, PNG);
    expect((await upload(own.id, memberCookies, PNG)).status).toBe(404);
    expect((await send(`/api/v1/pages/${own.id}/attachments`, { cookies: memberCookies })).status).toBe(404);
    const res = await getContents(created.id, memberCookies);
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toEqual({ code: "not_found", message: "添付ファイルが見つかりません" });
    expect((await deleteAttachmentRequest(created.id, memberCookies)).status).toBe(404);
    expect(await objectKeys()).toEqual([attachmentKey(created.id)]);
  });

  it("hides the attachments of an admin space from members", async () => {
    const adminSpace = await insertSpace("admin", "Admins");
    const page = await insertPage({ spaceId: adminSpace.id });
    const created = await uploadOk(page.id, adminCookies, PNG);
    const res = await upload(page.id, memberCookies, PNG);
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toEqual({ code: "not_found", message: "ページが見つかりません" });
    expect((await getContents(created.id, memberCookies)).status).toBe(404);
    expect((await deleteAttachmentRequest(created.id, memberCookies)).status).toBe(404);
    expect(await countAttachmentRows()).toBe(1);
  });

  it("hides the attachments while the page is in the trash, and shows them again once restored", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const created = await uploadOk(page.id, memberCookies, PNG);
    expect((await send(`/api/v1/pages/${page.id}`, { method: "DELETE", cookies: memberCookies })).status).toBe(204);

    expect((await upload(page.id, memberCookies, PNG)).status).toBe(404);
    expect((await send(`/api/v1/pages/${page.id}/attachments`, { cookies: memberCookies })).status).toBe(404);
    expect((await getContents(created.id, memberCookies)).status).toBe(404);
    expect((await deleteAttachmentRequest(created.id, memberCookies)).status).toBe(404);
    expect(await objectKeys()).toEqual([attachmentKey(created.id)]);

    expect((await send(`/api/v1/pages/${page.id}/restore`, { method: "POST", cookies: memberCookies })).status).toBe(200);
    const res = await getContents(created.id, memberCookies);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
  });

  it("moves the attachments with the page to another space", async () => {
    const adminSpace = await insertSpace("admin", "Admins");
    const page = await insertPage({ spaceId: everyone.id });
    const created = await uploadOk(page.id, memberCookies, PNG);
    const moved = await send(`/api/v1/pages/${page.id}/move`, {
      cookies: adminCookies,
      json: { version: 1, space_id: adminSpace.id },
    });
    expect(moved.status).toBe(200);
    expect((await getContents(created.id, memberCookies)).status).toBe(404);
    const res = await getContents(created.id, adminCookies);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
  });

  it("returns 404 when the object is missing from R2", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const created = await uploadOk(page.id, memberCookies, PNG);
    await env.ATTACHMENTS.delete(attachmentKey(created.id));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await getContents(created.id, memberCookies);
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toEqual({ code: "not_found", message: "添付ファイルが見つかりません" });
    expect(warn).toHaveBeenCalledWith("attachment object missing", { id: created.id });
  });

  it("deletes the rows with the page when it is deleted from the trash", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const created = await uploadOk(page.id, adminCookies, PNG);
    await db.update(pages).set({ deletedAt: T0, deletedBy: admin.id }).where(eq(pages.id, page.id)).run();
    expect((await send(`/api/v1/pages/${page.id}/permanent`, { method: "DELETE", cookies: adminCookies })).status).toBe(
      204,
    );
    expect(await countAttachmentRows()).toBe(0);
    expect((await getContents(created.id, adminCookies)).status).toBe(404);
    // The object stays until the scheduled job.
    expect(await objectKeys()).toEqual([attachmentKey(created.id)]);
  });
});

describe("changes between the check and the write", () => {
  it.each([
    ["bytes", (): AttachmentContent => ({ kind: "bytes", bytes: PNG })],
    ["a stream", (): AttachmentContent => ({ kind: "stream", stream: fixedLength(streamOf(PNG, 5), PNG.byteLength) })],
  ])("writes no row and deletes the object when the page moves to the trash before the insert, for %s", async (_, content) => {
    const page = await insertPage({ spaceId: everyone.id });
    const changing = dbChangingBefore(/^insert into "attachments"/i, () =>
      db.update(pages).set({ deletedAt: T0, deletedBy: member.id }).where(eq(pages.id, page.id)).run(),
    );
    const result = await createAttachment(changing, env.ATTACHMENTS, member, page.id, {
      filename: "a.png",
      contentType: "image/png",
      content: content(),
    });
    expect(result).toEqual({ ok: false, error: "not_found" });
    expect(await countAttachmentRows()).toBe(0);
    expect(await objectKeys()).toEqual([]);
  });

  it("writes no row when the page moves to another space before the insert", async () => {
    const other = await insertSpace("everyone", "Other");
    const page = await insertPage({ spaceId: everyone.id });
    const changing = dbChangingBefore(/^insert into "attachments"/i, () =>
      db.update(pages).set({ spaceId: other.id }).where(eq(pages.id, page.id)).run(),
    );
    const result = await createAttachment(changing, env.ATTACHMENTS, member, page.id, {
      filename: "a.png",
      contentType: "image/png",
      content: { kind: "bytes", bytes: PNG },
    });
    expect(result).toEqual({ ok: false, error: "not_found" });
    expect(await objectKeys()).toEqual([]);
  });

  it("deletes the object and rethrows when the insert fails otherwise", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const failing = dbChangingBefore(/^insert into "attachments"/i, () => Promise.reject(new Error("D1 is down")));
    await expect(
      createAttachment(failing, env.ATTACHMENTS, member, page.id, {
        filename: "a.png",
        contentType: "image/png",
        content: { kind: "bytes", bytes: PNG },
      }),
    ).rejects.toMatchObject({ cause: new Error("D1 is down") });
    expect(await objectKeys()).toEqual([]);
  });

  it("deletes nothing when the page moves to the trash before the delete", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const created = await uploadOk(page.id, memberCookies, PNG);
    const changing = dbChangingBefore(/^delete from "attachments"/i, () =>
      db.update(pages).set({ deletedAt: T0, deletedBy: member.id }).where(eq(pages.id, page.id)).run(),
    );
    expect(await deleteAttachment(changing, env.ATTACHMENTS, member, created.id)).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await countAttachmentRows()).toBe(1);
    expect(await objectKeys()).toEqual([attachmentKey(created.id)]);
  });
});

describe("sweepOrphanAttachments", () => {
  async function putObject(key: string): Promise<void> {
    await env.ATTACHMENTS.put(key, PNG);
  }

  it("deletes only the old objects without a row under attachments/", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const kept = await uploadOk(page.id, memberCookies, PNG);
    const orphan = crypto.randomUUID();
    await putObject(attachmentKey(orphan));
    const otherKey = `other/${crypto.randomUUID()}`;
    await putObject("attachments/not-a-uuid");
    await putObject(otherKey);

    // Within 24 hours of the upload: nothing is deleted.
    expect(await sweepOrphanAttachments(appDb, env.ATTACHMENTS, Date.now())).toBe(0);
    expect(await objectKeys()).toHaveLength(4);

    const count = await sweepOrphanAttachments(appDb, env.ATTACHMENTS, Date.now() + DAY + 60_000);
    expect(count).toBe(1);
    expect(await objectKeys()).toEqual([attachmentKey(kept.id), "attachments/not-a-uuid", otherKey].sort());
    expect(await env.ATTACHMENTS.head(attachmentKey(orphan))).toBeNull();
  });

  it("goes through every page of the list", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const kept = await uploadOk(page.id, memberCookies, PNG);
    const orphans = Array.from({ length: 5 }, () => crypto.randomUUID());
    for (const id of orphans) await putObject(attachmentKey(id));
    let listCalls = 0;
    const bucket = {
      list: (options?: R2ListOptions) => {
        listCalls++;
        return env.ATTACHMENTS.list(options);
      },
      delete: (keys: string | string[]) => env.ATTACHMENTS.delete(keys),
    } as unknown as R2Bucket;

    // 6 objects, 2 per call.
    const count = await sweepOrphanAttachments(appDb, bucket, Date.now() + 2 * DAY, 2);
    expect(count).toBe(5);
    expect(listCalls).toBe(3);
    expect(await objectKeys()).toEqual([attachmentKey(kept.id)]);
  });
});

describe("scheduled handler", () => {
  it("deletes the objects of the pages it purges in the same run", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const created = await uploadOk(page.id, memberCookies, PNG);
    const now = Date.now() + 40 * DAY;
    setNow(now);
    await db.update(pages).set({ deletedAt: now - 31 * DAY }).where(eq(pages.id, page.id)).run();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await worker.scheduled(createScheduledController({ scheduledTime: now, cron: "0 18 * * *" }), env, createExecutionContext());

    expect(await db.query.attachments.findFirst({ where: eq(attachments.id, created.id) })).toBeUndefined();
    expect(await objectKeys()).toEqual([]);
    expect(log).toHaveBeenCalledWith("purged trash", { count: 1 });
    expect(log).toHaveBeenCalledWith("swept attachments", { count: 1 });
  });

  it("sweeps even when the purge fails, then throws", async () => {
    const orphan = crypto.randomUUID();
    await env.ATTACHMENTS.put(attachmentKey(orphan), PNG);
    setNow(Date.now() + 2 * DAY);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failingDb = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (query: string) => {
            if (/^delete from "pages"/i.test(query)) throw new Error("purge failed");
            return target.prepare(query);
          };
        }
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await expect(
      worker.scheduled(
        createScheduledController({ scheduledTime: Date.now(), cron: "0 18 * * *" }),
        { ...env, DB: failingDb },
        createExecutionContext(),
      ),
    ).rejects.toThrow("purge failed");
    expect(await objectKeys()).toEqual([]);
    expect(error).toHaveBeenCalledWith("purge trash failed", expect.anything());
  });

  it("purges even when the sweep fails, then throws", async () => {
    const page = await insertPage({ spaceId: everyone.id, deletedAt: T0 - 31 * DAY });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failingBucket = {
      list: () => Promise.reject(new Error("sweep failed")),
    } as unknown as R2Bucket;

    await expect(
      worker.scheduled(
        createScheduledController({ scheduledTime: T0, cron: "0 18 * * *" }),
        { ...env, ATTACHMENTS: failingBucket },
        createExecutionContext(),
      ),
    ).rejects.toThrow("sweep failed");
    expect(await db.query.pages.findFirst({ where: eq(pages.id, page.id) })).toBeUndefined();
    expect(error).toHaveBeenCalledWith("sweep attachments failed", expect.anything());
  });
});
