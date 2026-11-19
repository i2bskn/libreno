import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfSettings } from "../src/api/types";
import { clock } from "@i2bskn/workers-app-core";
import { siteSettings, spaces, type PageRow, type SpaceRow, type UserRow } from "../src/db/schema";
import { resolvePdfRenderer } from "../src/pdf/renderer";
import { createUser, db, insertPage, login, resetDb, send, type SessionCookies } from "./helpers";

const T0 = Date.UTC(2026, 10, 1);
const pageNotFound = "ページが見つかりません";

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

function readSettings() {
  return db.query.siteSettings.findFirst({ where: eq(siteSettings.id, 1) });
}

// A BROWSER binding whose quickAction answers with response, or throws it when it is an Error.
function fakeBrowser(response: Response | Error) {
  const quickAction = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  return { browser: { quickAction } as unknown as BrowserRun, quickAction };
}

function pdfResponse(): Response {
  return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
    status: 200,
    headers: { "Content-Type": "application/pdf" },
  });
}

const HTML = '<!doctype html><html lang="ja"><head><title>t</title></head><body><p>本文</p></body></html>';

function postPdf(
  pageId: string,
  cookies: SessionCookies | undefined,
  // browser null removes the BROWSER binding that wrangler.jsonc declares.
  options: { browser?: BrowserRun | null; renderer?: string; body?: BodyInit; contentType?: string } = {},
): Promise<Response> {
  const env: Partial<Cloudflare.Env> = {};
  if (options.renderer !== undefined) env.PDF_RENDERER = options.renderer;
  if (options.browser !== undefined) env.BROWSER = options.browser ?? undefined;
  return send(`/api/v1/pages/${pageId}/pdf`, {
    method: "POST",
    cookies,
    body: options.body ?? HTML,
    headers: { "Content-Type": options.contentType ?? "text/html; charset=utf-8" },
    env,
  });
}

let admin: UserRow;
let member: UserRow;
let adminCookies: SessionCookies;
let memberCookies: SessionCookies;
let everyone: SpaceRow;
let page: PageRow;

beforeEach(async () => {
  await resetDb();
  vi.spyOn(clock, "now").mockReturnValue(T0);
  admin = await createUser({ email: "admin@example.com", role: "admin", createdAt: T0 });
  member = await createUser({ email: "member@example.com", role: "member", createdAt: T0 });
  adminCookies = await login(admin.email);
  memberCookies = await login(member.email);
  everyone = await insertSpace("everyone", "Everyone");
  page = await insertPage({ spaceId: everyone.id, title: "見積書: 2026/11", body: "# 見積", at: T0 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolvePdfRenderer", () => {
  const browser = {} as BrowserRun;

  it("is print when PDF_RENDERER is not set or is print", () => {
    expect(resolvePdfRenderer({})).toBe("print");
    expect(resolvePdfRenderer({ BROWSER: browser })).toBe("print");
    expect(resolvePdfRenderer({ PDF_RENDERER: "", BROWSER: browser })).toBe("print");
    expect(resolvePdfRenderer({ PDF_RENDERER: "print", BROWSER: browser })).toBe("print");
  });

  it("is server when PDF_RENDERER is browser and the binding exists", () => {
    expect(resolvePdfRenderer({ PDF_RENDERER: "browser", BROWSER: browser })).toBe("server");
  });

  it("is print when PDF_RENDERER is browser but the binding is missing", () => {
    expect(resolvePdfRenderer({ PDF_RENDERER: "browser" })).toBe("print");
  });

  it("is print for an unknown value, with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolvePdfRenderer({ PDF_RENDERER: "chrome", BROWSER: browser })).toBe("print");
    expect(warn).toHaveBeenCalled();
  });
});

describe("GET /api/v1/pdf-settings", () => {
  it("returns 401 without a session", async () => {
    expect((await send("/api/v1/pdf-settings")).status).toBe(401);
  });

  it("returns nulls without a row of site_settings", async () => {
    const res = await send("/api/v1/pdf-settings", { cookies: memberCookies });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ renderer: "print", issuer: null, confidentiality: null });
  });

  it("returns the saved values to every user", async () => {
    await send("/api/v1/pdf-settings", {
      method: "PUT",
      cookies: adminCookies,
      json: { issuer: "株式会社サンプル", confidentiality: "社外秘" },
    });
    const res = await send("/api/v1/pdf-settings", { cookies: memberCookies });
    expect(await res.json()).toEqual({ renderer: "print", issuer: "株式会社サンプル", confidentiality: "社外秘" });
  });

  it("follows PDF_RENDERER and the binding", async () => {
    const { browser } = fakeBrowser(pdfResponse());
    const server = await send("/api/v1/pdf-settings", {
      cookies: memberCookies,
      env: { PDF_RENDERER: "browser", BROWSER: browser },
    });
    expect(((await server.json()) as PdfSettings).renderer).toBe("server");
    const withoutBinding = await send("/api/v1/pdf-settings", {
      cookies: memberCookies,
      env: { PDF_RENDERER: "browser", BROWSER: undefined },
    });
    expect(((await withoutBinding.json()) as PdfSettings).renderer).toBe("print");
  });
});

describe("PUT /api/v1/pdf-settings", () => {
  function put(cookies: SessionCookies | undefined, json: unknown): Promise<Response> {
    return send("/api/v1/pdf-settings", { method: "PUT", cookies, json });
  }

  it("saves trimmed values for an admin, without touching the top page", async () => {
    await db.insert(siteSettings).values({ id: 1, topPageId: page.id, updatedBy: null, updatedAt: T0 - 1000 });
    const res = await put(adminCookies, { issuer: "  株式会社サンプル ", confidentiality: " 社外秘" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ renderer: "print", issuer: "株式会社サンプル", confidentiality: "社外秘" });
    expect(await readSettings()).toEqual({
      id: 1,
      topPageId: page.id,
      pdfIssuer: "株式会社サンプル",
      pdfConfidentiality: "社外秘",
      updatedBy: admin.id,
      updatedAt: T0,
    });
  });

  it("creates the row when there is none", async () => {
    const res = await put(adminCookies, { issuer: "A", confidentiality: null });
    expect(res.status).toBe(200);
    expect(await readSettings()).toMatchObject({ topPageId: null, pdfIssuer: "A", pdfConfidentiality: null });
  });

  it("saves an empty string as null and clears with null", async () => {
    await put(adminCookies, { issuer: "A", confidentiality: "B" });
    const res = await put(adminCookies, { issuer: "   ", confidentiality: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ renderer: "print", issuer: null, confidentiality: null });
    expect(await readSettings()).toMatchObject({ pdfIssuer: null, pdfConfidentiality: null });
  });

  it("accepts 100 characters and rejects 101", async () => {
    const ok = await put(adminCookies, { issuer: "あ".repeat(100), confidentiality: null });
    expect(ok.status).toBe(200);
    const res = await put(adminCookies, { issuer: "あ".repeat(101), confidentiality: null });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("invalid_pdf_settings");
  });

  it("rejects line breaks, control characters and bidirectional controls, even at the ends", async () => {
    for (const value of ["社外\n秘", "社外秘\n", "社外\u0007秘", "社外‮秘", "⁦社外秘"]) {
      const res = await put(adminCookies, { issuer: null, confidentiality: value });
      expect(res.status, JSON.stringify(value)).toBe(400);
      expect(await errorOf(res)).toEqual({
        code: "invalid_pdf_settings",
        message: "発行者と機密表示は改行を含まない100文字以内で入力してください",
      });
    }
  });

  it("rejects values that are not strings or null, and missing keys", async () => {
    for (const json of [
      { issuer: 1, confidentiality: null },
      { issuer: null, confidentiality: false },
      { issuer: "A" },
      { confidentiality: "B" },
      {},
    ]) {
      const res = await put(adminCookies, json);
      expect(res.status, JSON.stringify(json)).toBe(400);
      expect((await errorOf(res)).code).toBe("invalid_pdf_settings");
    }
    expect(await readSettings()).toBeUndefined();
  });

  it("returns 403 for a member and 401 without a session", async () => {
    expect((await put(memberCookies, { issuer: "A", confidentiality: null })).status).toBe(403);
    expect((await put(undefined, { issuer: "A", confidentiality: null })).status).toBe(401);
    expect(await readSettings()).toBeUndefined();
  });
});

describe("POST /api/v1/pages/:id/pdf", () => {
  it("returns the PDF made by Browser Run, with the options that keep the document offline", async () => {
    const { browser, quickAction } = fakeBrowser(pdfResponse());
    const res = await postPdf(page.id, memberCookies, { renderer: "browser", browser });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="document.pdf"; filename*=UTF-8''${encodeURIComponent("見積書_ 2026_11.pdf")}`,
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    expect(quickAction).toHaveBeenCalledTimes(1);
    expect(quickAction).toHaveBeenCalledWith("pdf", {
      html: HTML,
      setJavaScriptEnabled: false,
      allowRequestPattern: ["^data:"],
      gotoOptions: { waitUntil: "load" },
      cacheTTL: 0,
      pdfOptions: { format: "a4", printBackground: true, preferCSSPageSize: true, outline: true },
    });
  });

  it("returns 400 server_pdf_disabled when the renderer is print", async () => {
    const { browser, quickAction } = fakeBrowser(pdfResponse());
    for (const options of [{ browser }, { renderer: "print", browser }, { renderer: "browser", browser: null }]) {
      const res = await postPdf(page.id, memberCookies, options);
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toEqual({
        code: "server_pdf_disabled",
        message: "サーバーでのPDF生成は設定されていません",
      });
    }
    expect(quickAction).not.toHaveBeenCalled();
  });

  it("returns 401 without a session", async () => {
    const { browser } = fakeBrowser(pdfResponse());
    expect((await postPdf(page.id, undefined, { renderer: "browser", browser })).status).toBe(401);
  });

  it("returns 404 for a page in another user's personal space, in the trash, or missing", async () => {
    const { browser, quickAction } = fakeBrowser(pdfResponse());
    const personal = await insertPage({ spaceId: (await personalSpaceOf(admin)).id, title: "Private" });
    const trashed = await insertPage({ spaceId: everyone.id, title: "Trashed", deletedAt: T0, deletedBy: admin.id });
    for (const id of [personal.id, trashed.id, crypto.randomUUID()]) {
      const res = await postPdf(id, memberCookies, { renderer: "browser", browser });
      expect(res.status).toBe(404);
      expect(await errorOf(res)).toEqual({ code: "not_found", message: pageNotFound });
    }
    expect(quickAction).not.toHaveBeenCalled();
  });

  it("allows a page of an archived space", async () => {
    await db.update(spaces).set({ archivedAt: T0 }).where(eq(spaces.id, everyone.id)).run();
    const { browser } = fakeBrowser(pdfResponse());
    const res = await postPdf(page.id, memberCookies, { renderer: "browser", browser });
    expect(res.status).toBe(200);
  });

  it("returns 415 when the body is not text/html", async () => {
    const { browser, quickAction } = fakeBrowser(pdfResponse());
    for (const contentType of ["text/plain", "application/json"]) {
      const res = await postPdf(page.id, memberCookies, { renderer: "browser", browser, contentType });
      expect(res.status).toBe(415);
      expect((await errorOf(res)).code).toBe("unsupported_media_type");
    }
    expect(quickAction).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_html for an empty body", async () => {
    const { browser, quickAction } = fakeBrowser(pdfResponse());
    for (const body of ["", "  \n "]) {
      const res = await postPdf(page.id, memberCookies, { renderer: "browser", browser, body });
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("invalid_html");
    }
    expect(quickAction).not.toHaveBeenCalled();
  });

  it("returns 413 for a body over 20 MiB, by Content-Length and by the bytes read", async () => {
    const { browser, quickAction } = fakeBrowser(pdfResponse());
    const max = 20 * 1024 * 1024;
    const declared = await send(`/api/v1/pages/${page.id}/pdf`, {
      method: "POST",
      cookies: memberCookies,
      body: HTML,
      headers: { "Content-Type": "text/html", "Content-Length": String(max + 1) },
      env: { PDF_RENDERER: "browser", BROWSER: browser },
    });
    expect(declared.status).toBe(413);
    expect(await errorOf(declared)).toEqual({
      code: "pdf_too_large",
      message: "画像が大きすぎてPDFを作れませんでした。ブラウザで印刷してください",
    });

    // A stream has no Content-Length, so the bytes are counted as they are read.
    const large = new Uint8Array(max + 1).fill(0x61);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < large.length; offset += 1024 * 1024) {
          controller.enqueue(large.subarray(offset, offset + 1024 * 1024));
        }
        controller.close();
      },
    });
    const read = await postPdf(page.id, memberCookies, { renderer: "browser", browser, body: stream });
    expect(read.status).toBe(413);
    expect((await errorOf(read)).code).toBe("pdf_too_large");

    const exact = await postPdf(page.id, memberCookies, {
      renderer: "browser",
      browser,
      body: new Uint8Array(max).fill(0x61),
    });
    expect(exact.status).toBe(200);
    expect(quickAction).toHaveBeenCalledTimes(1);
  });

  it("returns 503 when Browser Run answers 429", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { browser } = fakeBrowser(new Response('{"errors":[]}', { status: 429 }));
    const res = await postPdf(page.id, memberCookies, { renderer: "browser", browser });
    expect(res.status).toBe(503);
    expect(await errorOf(res)).toEqual({
      code: "pdf_limit_exceeded",
      message: "PDFの生成の上限に達しました。しばらく待つか、ブラウザで印刷してください",
    });
  });

  it("returns 502 when Browser Run fails or throws, logging only the status or the message", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const response of [new Response("secret body", { status: 500 }), new Error("boom")]) {
      const { browser } = fakeBrowser(response);
      const res = await postPdf(page.id, memberCookies, { renderer: "browser", browser });
      expect(res.status).toBe(502);
      expect(await errorOf(res)).toEqual({
        code: "pdf_failed",
        message: "PDFを作成できませんでした。ブラウザで印刷してください",
      });
    }
    expect(error).toHaveBeenCalledWith("pdf rendering failed", { status: 500 });
    expect(error).toHaveBeenCalledWith("pdf rendering failed", { message: "boom" });
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret body");
  });
});
