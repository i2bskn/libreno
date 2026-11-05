import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import type { Page, PageList } from "../src/api/types";
import { clock, isUniqueViolation } from "@i2bskn/workers-app-core";
import { isForeignKeyViolation } from "../src/db/errors";
import { pages, spaces, type SpaceRow, type UserRow } from "../src/db/schema";
import {
  countPages,
  createUser,
  db,
  insertPage,
  login,
  resetDb,
  send,
  type SessionCookies,
} from "./helpers";

const T0 = Date.UTC(2026, 9, 1);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BODY_MAX_BYTES = 524_288;

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

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

function createPage(spaceId: string, cookies: SessionCookies, json: unknown): Promise<Response> {
  return send(`/api/v1/spaces/${spaceId}/pages`, { cookies, json });
}

function patchPage(id: string, cookies: SessionCookies, json: unknown): Promise<Response> {
  return send(`/api/v1/pages/${id}`, { method: "PATCH", cookies, json });
}

// A D1 binding that deletes the space right before the page INSERT runs,
// as if another request deleted it between the access check and the INSERT.
function deletingSpaceBeforePageInsert(spaceId: string): D1Database {
  const real = env.DB;
  const deleteSpace = () => real.prepare("DELETE FROM spaces WHERE id = ?").bind(spaceId).run();
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          if (!/^insert into "pages"/i.test(query)) return statement;
          return {
            bind: (...values: unknown[]) => {
              const bound = statement.bind(...values);
              return {
                all: async () => (await deleteSpace(), bound.all()),
                raw: async () => (await deleteSpace(), bound.raw()),
                run: async () => (await deleteSpace(), bound.run()),
                first: async () => (await deleteSpace(), bound.first()),
              };
            },
          };
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

let admin: UserRow;
let member: UserRow;
let adminCookies: SessionCookies;
let memberCookies: SessionCookies;
let everyone: SpaceRow;

beforeEach(async () => {
  await resetDb();
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

describe("POST /api/v1/spaces/:id/pages", () => {
  it("creates a page with version 1 and a trimmed title", async () => {
    const res = await createPage(everyone.id, memberCookies, { title: "  Hello  ", body: "  # Hi\n\n" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Page;
    expect(body).toEqual({
      id: expect.stringMatching(UUID_V4),
      space_id: everyone.id,
      folder_id: null,
      title: "Hello",
      body: "  # Hi\n\n",
      version: 1,
      created_by: member.id,
      updated_by: member.id,
      created_at: T0,
      updated_at: T0,
    });
    const row = await db.query.pages.findFirst({ where: eq(pages.id, body.id) });
    expect(row).toMatchObject({ spaceId: everyone.id, title: "Hello", body: "  # Hi\n\n", version: 1 });
  });

  it("accepts an empty body, a title of 200 code points and a body of exactly 512KB", async () => {
    const title = "あ".repeat(199) + "😀";
    const body = "a".repeat(BODY_MAX_BYTES - 3) + "あ";
    expect(new TextEncoder().encode(body).byteLength).toBe(BODY_MAX_BYTES);

    const res = await createPage(everyone.id, adminCookies, { title, body });
    expect(res.status).toBe(201);
    const created = (await res.json()) as Page;
    expect(created.title).toBe(title);
    expect((await db.query.pages.findFirst({ where: eq(pages.id, created.id) }))?.body).toBe(body);

    expect((await createPage(everyone.id, adminCookies, { title: "Empty", body: "" })).status).toBe(201);
  });

  it("validates input", async () => {
    const tooLong = "a".repeat(BODY_MAX_BYTES - 2) + "あ";
    expect(new TextEncoder().encode(tooLong).byteLength).toBe(BODY_MAX_BYTES + 1);
    const cases: [unknown, string][] = [
      ["not json", "invalid_body"],
      [[], "invalid_body"],
      [{ body: "" }, "invalid_title"],
      [{ title: "", body: "" }, "invalid_title"],
      [{ title: "   ", body: "" }, "invalid_title"],
      [{ title: "a".repeat(201), body: "" }, "invalid_title"],
      [{ title: "a\nb", body: "" }, "invalid_title"],
      [{ title: "a\tb", body: "" }, "invalid_title"],
      [{ title: "a\uD800b", body: "" }, "invalid_title"],
      [{ title: null, body: "" }, "invalid_title"],
      [{ title: 1, body: "" }, "invalid_title"],
      [{ title: "", body: 1 }, "invalid_title"],
      [{ title: "T" }, "invalid_page_body"],
      [{ title: "T", body: null }, "invalid_page_body"],
      [{ title: "T", body: 1 }, "invalid_page_body"],
      [{ title: "T", body: "a\u0000b" }, "invalid_page_body"],
      [{ title: "T", body: "a\uDC00b" }, "invalid_page_body"],
      [{ title: "T", body: tooLong }, "invalid_page_body"],
    ];
    for (const [json, code] of cases) {
      const res = await createPage(everyone.id, adminCookies, json);
      expect(res.status, JSON.stringify(json).slice(0, 80)).toBe(400);
      expect(await errorCode(res)).toBe(code);
    }
    expect(await countPages()).toBe(0);
  });

  it("returns 404 for inaccessible and unknown spaces", async () => {
    const adminOnly = await insertSpace("admin", "Admins");
    for (const [cookies, spaceId] of [
      [memberCookies, adminOnly.id],
      [memberCookies, (await personalSpaceOf(admin)).id],
      [adminCookies, (await personalSpaceOf(member)).id],
      [adminCookies, "nope"],
    ] as const) {
      const res = await createPage(spaceId, cookies, { title: "T", body: "" });
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe("not_found");
    }
    expect(await countPages()).toBe(0);
  });

  it("returns 404 when the space is deleted between the check and the INSERT", async () => {
    const space = await insertSpace("everyone", "Doomed");
    const res = await send(`/api/v1/spaces/${space.id}/pages`, {
      cookies: memberCookies,
      json: { title: "T", body: "" },
      env: { DB: deletingSpaceBeforePageInsert(space.id) },
    });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("not_found");
    expect(await db.query.spaces.findFirst({ where: eq(spaces.id, space.id) })).toBeUndefined();
    expect(await countPages()).toBe(0);
  });
});

describe("GET /api/v1/spaces/:id/pages", () => {
  it("lists pages of the space without bodies, newest first then by id", async () => {
    const other = await insertSpace("everyone", "Other");
    const older = await insertPage({ spaceId: everyone.id, title: "Older", body: "x", at: T0 + 1 });
    const tieB = await insertPage({ spaceId: everyone.id, title: "Tie B", at: T0 + 2, id: "b" });
    const tieA = await insertPage({ spaceId: everyone.id, title: "Tie A", at: T0 + 2, id: "a" });
    await insertPage({ spaceId: other.id, title: "Elsewhere", at: T0 + 3 });

    // An update moves a page to the top.
    setNow(T0 + 10);
    expect((await patchPage(older.id, memberCookies, { version: 1, title: "Updated" })).status).toBe(200);

    const res = await send(`/api/v1/spaces/${everyone.id}/pages`, { cookies: memberCookies });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PageList;
    expect(body.pages.map((p) => p.id)).toEqual([older.id, tieA.id, tieB.id]);
    expect(body.pages[0]).toEqual({
      id: older.id,
      space_id: everyone.id,
      folder_id: null,
      title: "Updated",
      version: 2,
      created_by: null,
      updated_by: member.id,
      created_at: T0 + 1,
      updated_at: T0 + 10,
    });
    for (const page of body.pages) expect(page).not.toHaveProperty("body");
  });

  it("returns an empty list for a space without pages", async () => {
    const res = await send(`/api/v1/spaces/${everyone.id}/pages`, { cookies: memberCookies });
    expect(await res.json()).toEqual({ pages: [] });
  });

  it("returns 404 for inaccessible and unknown spaces", async () => {
    const adminOnly = await insertSpace("admin", "Admins");
    for (const [cookies, spaceId] of [
      [memberCookies, adminOnly.id],
      [memberCookies, (await personalSpaceOf(admin)).id],
      [adminCookies, (await personalSpaceOf(member)).id],
      [adminCookies, "nope"],
    ] as const) {
      const res = await send(`/api/v1/spaces/${spaceId}/pages`, { cookies });
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe("not_found");
    }
  });

  it("returns 401 without a session", async () => {
    expect((await send(`/api/v1/spaces/${everyone.id}/pages`)).status).toBe(401);
  });
});

describe("GET /api/v1/pages/:id", () => {
  it("returns the page with its body", async () => {
    const page = await insertPage({ spaceId: everyone.id, title: "Hello", body: "# Hi", createdBy: admin.id, at: T0 });
    const res = await send(`/api/v1/pages/${page.id}`, { cookies: memberCookies });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: page.id,
      space_id: everyone.id,
      folder_id: null,
      title: "Hello",
      body: "# Hi",
      version: 1,
      created_by: admin.id,
      updated_by: admin.id,
      created_at: T0,
      updated_at: T0,
    });
  });

  it("returns 401 without a session", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    expect((await send(`/api/v1/pages/${page.id}`)).status).toBe(401);
  });
});

describe("page access", () => {
  it("returns 404 for GET, PATCH and DELETE of pages in inaccessible spaces", async () => {
    const adminOnly = await insertSpace("admin", "Admins");
    const adminPage = await insertPage({ spaceId: adminOnly.id });
    const adminPersonalPage = await insertPage({ spaceId: (await personalSpaceOf(admin)).id });
    const memberPersonalPage = await insertPage({ spaceId: (await personalSpaceOf(member)).id });

    for (const [cookies, id] of [
      [memberCookies, adminPage.id],
      [memberCookies, adminPersonalPage.id],
      [adminCookies, memberPersonalPage.id],
      [adminCookies, "nope"],
    ] as const) {
      for (const res of [
        await send(`/api/v1/pages/${id}`, { cookies }),
        await patchPage(id, cookies, { version: 1, title: "Taken over" }),
        await send(`/api/v1/pages/${id}`, { method: "DELETE", cookies }),
      ]) {
        expect(res.status).toBe(404);
        expect(await errorCode(res)).toBe("not_found");
      }
    }
    expect(await countPages()).toBe(3);
    for (const page of [adminPage, adminPersonalPage, memberPersonalPage]) {
      expect(await db.query.pages.findFirst({ where: eq(pages.id, page.id) })).toEqual(page);
    }
  });

  it("lets the owner use pages in their personal space", async () => {
    const page = await insertPage({ spaceId: (await personalSpaceOf(member)).id });
    expect((await send(`/api/v1/pages/${page.id}`, { cookies: memberCookies })).status).toBe(200);
    expect((await patchPage(page.id, memberCookies, { version: 1, body: "mine" })).status).toBe(200);
    expect((await send(`/api/v1/pages/${page.id}`, { method: "DELETE", cookies: memberCookies })).status).toBe(204);
  });

  it("hides admin space pages once the role is changed to member", async () => {
    await createUser({ email: "second-admin@example.com", role: "admin" });
    const adminOnly = await insertSpace("admin", "Admins");
    const page = await insertPage({ spaceId: adminOnly.id });
    expect((await send(`/api/v1/pages/${page.id}`, { cookies: adminCookies })).status).toBe(200);

    const demote = await send(`/api/v1/users/${admin.id}`, { method: "PATCH", cookies: adminCookies, json: { role: "member" } });
    expect(demote.status).toBe(200);
    expect((await send(`/api/v1/pages/${page.id}`, { cookies: adminCookies })).status).toBe(404);
    expect((await patchPage(page.id, adminCookies, { version: 1, body: "x" })).status).toBe(404);
    expect((await send(`/api/v1/pages/${page.id}`, { method: "DELETE", cookies: adminCookies })).status).toBe(404);
    expect((await send(`/api/v1/spaces/${adminOnly.id}/pages`, { cookies: adminCookies })).status).toBe(404);
  });
});

describe("PATCH /api/v1/pages/:id", () => {
  it("updates only the title and keeps the body", async () => {
    const page = await insertPage({ spaceId: everyone.id, title: "Old", body: "Body", createdBy: admin.id, at: T0 });
    setNow(T0 + 1000);
    const res = await patchPage(page.id, memberCookies, { version: 1, title: "  New  " });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Page;
    expect(body).toEqual({
      id: page.id,
      space_id: everyone.id,
      folder_id: null,
      title: "New",
      body: "Body",
      version: 2,
      created_by: admin.id,
      updated_by: member.id,
      created_at: T0,
      updated_at: T0 + 1000,
    });
    expect(await db.query.pages.findFirst({ where: eq(pages.id, page.id) })).toMatchObject({
      title: "New",
      body: "Body",
      version: 2,
      updatedBy: member.id,
      updatedAt: T0 + 1000,
    });
  });

  it("updates only the body and keeps the title", async () => {
    const page = await insertPage({ spaceId: everyone.id, title: "Title", body: "Old" });
    const res = await patchPage(page.id, adminCookies, { version: 1, body: "  New\n" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ title: "Title", body: "  New\n", version: 2, updated_by: admin.id });
  });

  it("increments the version even if nothing changed", async () => {
    const page = await insertPage({ spaceId: everyone.id, title: "Same", body: "Same" });
    const res = await patchPage(page.id, adminCookies, { version: 1, title: "Same", body: "Same" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Page).version).toBe(2);
  });

  it("returns 409 version_conflict for a stale version", async () => {
    const page = await insertPage({ spaceId: everyone.id, title: "Title", body: "Body" });
    expect((await patchPage(page.id, adminCookies, { version: 1, body: "first" })).status).toBe(200);
    const second = await patchPage(page.id, memberCookies, { version: 1, body: "second" });
    expect(second.status).toBe(409);
    expect(await errorCode(second)).toBe("version_conflict");
    const future = await patchPage(page.id, memberCookies, { version: 5, body: "future" });
    expect(future.status).toBe(409);
    expect(await db.query.pages.findFirst({ where: eq(pages.id, page.id) })).toMatchObject({
      body: "first",
      version: 2,
      updatedBy: admin.id,
    });
  });

  it("validates input in order: version, empty update, title, body", async () => {
    const page = await insertPage({ spaceId: everyone.id, title: "Title", body: "Body" });
    const cases: [unknown, string][] = [
      ["not json", "invalid_body"],
      [{ title: "T" }, "invalid_version"],
      [{ version: 0, title: "T" }, "invalid_version"],
      [{ version: 1.5, title: "T" }, "invalid_version"],
      [{ version: "1", title: "T" }, "invalid_version"],
      [{ version: null, title: "T" }, "invalid_version"],
      [{ version: 2 ** 53, title: "T" }, "invalid_version"],
      [{ version: 0 }, "invalid_version"],
      [{ version: 1 }, "empty_update"],
      [{ version: 1, title: "", body: "a\u0000" }, "invalid_title"],
      [{ version: 1, title: null }, "invalid_title"],
      [{ version: 1, title: "a\nb" }, "invalid_title"],
      [{ version: 1, body: null }, "invalid_page_body"],
      [{ version: 1, title: "T", body: 1 }, "invalid_page_body"],
      [{ version: 1, body: "a\u0000b" }, "invalid_page_body"],
    ];
    for (const [json, code] of cases) {
      const res = await patchPage(page.id, adminCookies, json);
      expect(res.status, JSON.stringify(json)).toBe(400);
      expect(await errorCode(res)).toBe(code);
    }
    expect(await db.query.pages.findFirst({ where: eq(pages.id, page.id) })).toEqual(page);
  });
});

describe("DELETE /api/v1/pages/:id", () => {
  it("deletes the page", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const kept = await insertPage({ spaceId: everyone.id });
    const res = await send(`/api/v1/pages/${page.id}`, { method: "DELETE", cookies: memberCookies });
    expect(res.status).toBe(204);
    expect((await send(`/api/v1/pages/${page.id}`, { cookies: memberCookies })).status).toBe(404);
    expect((await send(`/api/v1/pages/${page.id}`, { method: "DELETE", cookies: memberCookies })).status).toBe(404);
    expect(await db.query.pages.findFirst({ where: eq(pages.id, kept.id) })).toEqual(kept);
  });

  it("returns 404 for an unknown id", async () => {
    const res = await send("/api/v1/pages/nope", { method: "DELETE", cookies: adminCookies });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("not_found");
  });
});

describe("isForeignKeyViolation", () => {
  it("detects a foreign key violation from a drizzle insert", async () => {
    const error = await db
      .insert(pages)
      .values({ id: crypto.randomUUID(), spaceId: "nope", title: "T", body: "", version: 1, createdAt: T0, updatedAt: T0 })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(Error);
    expect(isForeignKeyViolation(error)).toBe(true);
    expect(isUniqueViolation(error)).toBe(false);
    expect(await countPages()).toBe(0);
  });

  it("does not report a UNIQUE violation as a foreign key violation", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const error = await insertPage({ spaceId: everyone.id, id: page.id }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isUniqueViolation(error)).toBe(true);
    expect(isForeignKeyViolation(error)).toBe(false);
  });
});

describe("error messages", () => {
  async function errorBody(res: Response): Promise<{ code: string; message: string }> {
    return ((await res.json()) as { error: { code: string; message: string } }).error;
  }

  it("returns the message for each error code", async () => {
    const page = await insertPage({ spaceId: everyone.id, title: "Title", body: "Body" });
    const cases: [Promise<Response>, string, string][] = [
      [
        patchPage(page.id, adminCookies, { version: 1, title: "   " }),
        "invalid_title",
        "タイトルは 1 文字以上 200 文字以下で、改行などの制御文字を含まない文字列にしてください",
      ],
      [
        patchPage(page.id, adminCookies, { version: 1, body: "a\u0000b" }),
        "invalid_page_body",
        "本文は 512KB 以下で、NUL 文字を含まない文字列にしてください",
      ],
      [
        patchPage(page.id, adminCookies, { version: 0, title: "T" }),
        "invalid_version",
        "version は 1 以上の整数で指定してください",
      ],
      [patchPage(page.id, adminCookies, { version: 1 }), "empty_update", "title、body、folder_id のいずれかを指定してください"],
      [
        patchPage(page.id, adminCookies, { version: 5, title: "T" }),
        "version_conflict",
        "ページが他の人に更新されています。最新の内容を取得してからやり直してください",
      ],
      [patchPage("nope", adminCookies, { version: 1, title: "T" }), "not_found", "ページが見つかりません"],
    ];
    for (const [request, code, message] of cases) {
      expect(await errorBody(await request)).toEqual({ code, message });
    }
  });
});
