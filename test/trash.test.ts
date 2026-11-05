import { createExecutionContext, createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page, PageList, SearchResult, TrashList } from "../src/api/types";
import { clock } from "@i2bskn/workers-app-core";
import { folders, pages, spaces, type FolderRow, type PageRow, type SpaceRow, type UserRow } from "../src/db/schema";
import { pageUpdateWhere } from "../src/pages/service";
import { purgeExpiredTrash, TRASH_RETENTION_MS } from "../src/pages/trash";
import worker from "../src/index";
import {
  appDb,
  createUser,
  db,
  insertFolder,
  insertPage,
  login,
  resetDb,
  send,
  type SessionCookies,
} from "./helpers";

const T0 = Date.UTC(2026, 9, 1);
const DAY = 24 * 60 * 60 * 1000;
const pageNotFound = "ページが見つかりません";

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

function readPage(id: string): Promise<PageRow | undefined> {
  return db.query.pages.findFirst({ where: eq(pages.id, id) });
}

function readFolder(id: string): Promise<FolderRow | undefined> {
  return db.query.folders.findFirst({ where: eq(folders.id, id) });
}

async function countRevisions(pageId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM page_revisions WHERE page_id = ?")
    .bind(pageId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

function trashPage(id: string, cookies: SessionCookies): Promise<Response> {
  return send(`/api/v1/pages/${id}`, { method: "DELETE", cookies });
}

function restorePage(id: string, cookies: SessionCookies): Promise<Response> {
  return send(`/api/v1/pages/${id}/restore`, { method: "POST", cookies });
}

function purgePage(id: string, cookies: SessionCookies): Promise<Response> {
  return send(`/api/v1/pages/${id}/permanent`, { method: "DELETE", cookies });
}

function patchPage(id: string, cookies: SessionCookies, json: unknown): Promise<Response> {
  return send(`/api/v1/pages/${id}`, { method: "PATCH", cookies, json });
}

async function listTrash(spaceId: string, cookies: SessionCookies): Promise<TrashList> {
  const res = await send(`/api/v1/spaces/${spaceId}/trash`, { cookies });
  expect(res.status).toBe(200);
  return (await res.json()) as TrashList;
}

async function listPageIds(spaceId: string, cookies: SessionCookies): Promise<string[]> {
  const res = await send(`/api/v1/spaces/${spaceId}/pages`, { cookies });
  expect(res.status).toBe(200);
  return ((await res.json()) as PageList).pages.map((page) => page.id);
}

async function searchIds(q: string, cookies: SessionCookies): Promise<string[]> {
  const res = await send(`/api/v1/search?${new URLSearchParams({ q })}`, { cookies });
  expect(res.status).toBe(200);
  return ((await res.json()) as SearchResult).hits.map((hit) => hit.id);
}

let admin: UserRow;
let member: UserRow;
let adminCookies: SessionCookies;
let memberCookies: SessionCookies;
let everyone: SpaceRow;
let page: PageRow;

beforeEach(async () => {
  await resetDb();
  setNow(T0);
  admin = await createUser({ email: "admin@example.com", role: "admin", createdAt: T0 });
  member = await createUser({ email: "member@example.com", role: "member", createdAt: T0 });
  adminCookies = await login(admin.email);
  memberCookies = await login(member.email);
  everyone = await insertSpace("everyone", "Everyone");
  page = await insertPage({ spaceId: everyone.id, title: "Deploy", body: "deploy steps", createdBy: admin.id, at: T0 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DELETE /api/v1/pages/:id", () => {
  it("moves the page to the trash without changing its version or keeping a revision", async () => {
    expect((await patchPage(page.id, adminCookies, { version: 1, body: "v2" })).status).toBe(200);
    const before = await readPage(page.id);
    setNow(T0 + 1000);
    const res = await trashPage(page.id, memberCookies);
    expect(res.status).toBe(204);
    expect(await readPage(page.id)).toEqual({ ...before, deletedAt: T0 + 1000, deletedBy: member.id });
    expect(await countRevisions(page.id)).toBe(1);
  });

  it("hides the page from reads, lists, search, updates and its history", async () => {
    expect((await patchPage(page.id, adminCookies, { version: 1, body: "deploy v2" })).status).toBe(200);
    expect((await trashPage(page.id, memberCookies)).status).toBe(204);

    for (const res of [
      await send(`/api/v1/pages/${page.id}`, { cookies: memberCookies }),
      await patchPage(page.id, memberCookies, { version: 2, title: "Changed" }),
      await send(`/api/v1/pages/${page.id}/revisions`, { cookies: memberCookies }),
      await send(`/api/v1/pages/${page.id}/revisions/1`, { cookies: memberCookies }),
      await send(`/api/v1/pages/${page.id}/revisions/1/restore`, { cookies: memberCookies, json: { version: 2 } }),
      await trashPage(page.id, memberCookies),
    ]) {
      expect(res.status).toBe(404);
      expect(await errorOf(res)).toEqual({ code: "not_found", message: pageNotFound });
    }
    expect(await listPageIds(everyone.id, memberCookies)).toEqual([]);
    expect(await searchIds("deploy", memberCookies)).toEqual([]);
    expect(await readPage(page.id)).toMatchObject({ version: 2, title: "Deploy", body: "deploy v2" });
    expect(await countRevisions(page.id)).toBe(1);
  });

  it("returns 404 for a page in a space the user cannot access", async () => {
    const adminSpace = await insertSpace("admin", "Admins");
    const adminPage = await insertPage({ spaceId: adminSpace.id });
    const othersPage = await insertPage({ spaceId: (await personalSpaceOf(admin)).id });
    for (const target of [adminPage, othersPage]) {
      expect((await trashPage(target.id, memberCookies)).status).toBe(404);
      expect(await readPage(target.id)).toEqual(target);
    }
  });
});

describe("updates racing with the trash", () => {
  it("does not update a page in the trash with the condition of updatePage", async () => {
    expect((await trashPage(page.id, memberCookies)).status).toBe(204);
    const result = await db
      .update(pages)
      .set({ title: "x" })
      .where(pageUpdateWhere(page, page.version, undefined))
      .run();
    expect(result.meta.changes).toBe(0);
    expect(await readPage(page.id)).toMatchObject({ title: "Deploy" });
    expect(await countRevisions(page.id)).toBe(0);
  });
});

describe("GET /api/v1/spaces/:id/trash", () => {
  it("lists the pages in the trash of the space, most recently deleted first, without bodies", async () => {
    const older = await insertPage({ spaceId: everyone.id, title: "Older", deletedAt: T0 - DAY, deletedBy: admin.id });
    const newer = await insertPage({ spaceId: everyone.id, title: "Newer", deletedAt: T0, deletedBy: member.id });
    const other = await insertSpace("everyone", "Other");
    await insertPage({ spaceId: other.id, deletedAt: T0 });

    expect(await listTrash(everyone.id, memberCookies)).toEqual({
      pages: [
        {
          id: newer.id,
          space_id: everyone.id,
          folder_id: null,
          title: "Newer",
          version: 1,
          created_by: null,
          updated_by: null,
          created_at: newer.createdAt,
          updated_at: newer.updatedAt,
          deleted_at: T0,
          deleted_by: member.id,
          purge_after: T0 + 30 * DAY,
        },
        expect.objectContaining({ id: older.id, deleted_at: T0 - DAY, purge_after: T0 + 29 * DAY }),
      ],
    });
  });

  it("returns 404 for a space the user cannot access", async () => {
    const adminSpace = await insertSpace("admin", "Admins");
    for (const spaceId of [adminSpace.id, (await personalSpaceOf(admin)).id, "missing"]) {
      const res = await send(`/api/v1/spaces/${spaceId}/trash`, { cookies: memberCookies });
      expect(res.status).toBe(404);
      expect(await errorOf(res)).toEqual({ code: "not_found", message: "スペースが見つかりません" });
    }
  });
});

describe("POST /api/v1/pages/:id/restore", () => {
  it("takes the page out of the trash without changing its version", async () => {
    expect((await trashPage(page.id, memberCookies)).status).toBe(204);
    setNow(T0 + 1000);
    const res = await restorePage(page.id, memberCookies);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Page;
    expect(body).toMatchObject({ id: page.id, version: 1, updated_at: T0, body: "deploy steps" });
    expect(body).not.toHaveProperty("deleted_at");
    expect(await readPage(page.id)).toEqual(page);
    expect(await listPageIds(everyone.id, memberCookies)).toEqual([page.id]);
    expect(await searchIds("deploy", memberCookies)).toEqual([page.id]);
    expect((await listTrash(everyone.id, memberCookies)).pages).toEqual([]);
  });

  it("returns 409 not_in_trash for a page that is not in the trash", async () => {
    const res = await restorePage(page.id, memberCookies);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: "not_in_trash", message: "このページはゴミ箱にありません" });
  });

  it("returns 404 for a page in a space the user cannot access", async () => {
    const adminSpace = await insertSpace("admin", "Admins");
    const adminPage = await insertPage({ spaceId: adminSpace.id, deletedAt: T0 });
    const othersPage = await insertPage({ spaceId: (await personalSpaceOf(admin)).id, deletedAt: T0 });
    for (const target of [adminPage, othersPage, { id: "missing" }]) {
      const res = await restorePage(target.id, memberCookies);
      expect(res.status).toBe(404);
      expect(await errorOf(res)).toEqual({ code: "not_found", message: pageNotFound });
    }
    expect(await readPage(adminPage.id)).toEqual(adminPage);
  });

  it("puts the page back in its folder, or at the top level after the folder is deleted", async () => {
    const folder = await insertFolder({ spaceId: everyone.id });
    const kept = await insertPage({ spaceId: everyone.id, folderId: folder.id, deletedAt: T0 });
    expect((await restorePage(kept.id, memberCookies)).status).toBe(200);
    expect(await readPage(kept.id)).toMatchObject({ folderId: folder.id });

    const trashed = await insertPage({ spaceId: everyone.id, folderId: folder.id });
    expect((await trashPage(trashed.id, memberCookies)).status).toBe(204);
    expect((await trashPage(kept.id, memberCookies)).status).toBe(204);
    expect((await send(`/api/v1/folders/${folder.id}`, { method: "DELETE", cookies: memberCookies })).status).toBe(204);
    const res = await restorePage(trashed.id, memberCookies);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Page).folder_id).toBeNull();
  });
});

describe("DELETE /api/v1/pages/:id/permanent", () => {
  it("deletes a page in the trash with its revisions for an admin", async () => {
    expect((await patchPage(page.id, memberCookies, { version: 1, body: "v2" })).status).toBe(200);
    expect((await trashPage(page.id, memberCookies)).status).toBe(204);
    const res = await purgePage(page.id, adminCookies);
    expect(res.status).toBe(204);
    expect(await readPage(page.id)).toBeUndefined();
    expect(await countRevisions(page.id)).toBe(0);
  });

  it("returns 403 for a member", async () => {
    expect((await trashPage(page.id, memberCookies)).status).toBe(204);
    const res = await purgePage(page.id, memberCookies);
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toEqual({ code: "forbidden", message: "管理者の権限が必要です" });
    expect(await readPage(page.id)).toBeDefined();
  });

  it("returns 404 for a page in another user's personal space, even for an admin", async () => {
    const othersPage = await insertPage({ spaceId: (await personalSpaceOf(member)).id, deletedAt: T0 });
    const res = await purgePage(othersPage.id, adminCookies);
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toEqual({ code: "not_found", message: pageNotFound });
    expect(await readPage(othersPage.id)).toEqual(othersPage);
  });

  it("returns 403 for a page in the admin's own personal space", async () => {
    const ownPage = await insertPage({ spaceId: (await personalSpaceOf(admin)).id, deletedAt: T0 });
    const res = await purgePage(ownPage.id, adminCookies);
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toEqual({
      code: "forbidden",
      message: "個人スペースのページは完全に削除できません。30 日たつと自動で削除されます",
    });
    expect(await readPage(ownPage.id)).toEqual(ownPage);
  });

  it("returns 409 not_in_trash for a page that is not in the trash, such as one restored just before", async () => {
    expect((await trashPage(page.id, memberCookies)).status).toBe(204);
    expect((await restorePage(page.id, memberCookies)).status).toBe(200);
    const res = await purgePage(page.id, adminCookies);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({
      code: "not_in_trash",
      message: "ゴミ箱にないページは完全に削除できません。先にゴミ箱へ移してください",
    });
    expect(await readPage(page.id)).toEqual(page);
  });
});

describe("deleting folders with pages in the trash", () => {
  it("returns 409 while the folder has a page outside the trash", async () => {
    const folder = await insertFolder({ spaceId: everyone.id });
    await insertPage({ spaceId: everyone.id, folderId: folder.id });
    await insertPage({ spaceId: everyone.id, folderId: folder.id, deletedAt: T0 });
    const res = await send(`/api/v1/folders/${folder.id}`, { method: "DELETE", cookies: memberCookies });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("folder_not_empty");
    expect(await readFolder(folder.id)).toEqual(folder);
  });

  it("deletes a folder with only pages in the trash and moves them to the top level", async () => {
    const folder = await insertFolder({ spaceId: everyone.id });
    const trashed = await insertPage({ spaceId: everyone.id, folderId: folder.id, deletedAt: T0 });
    const res = await send(`/api/v1/folders/${folder.id}`, { method: "DELETE", cookies: memberCookies });
    expect(res.status).toBe(204);
    expect(await readFolder(folder.id)).toBeUndefined();
    expect(await readPage(trashed.id)).toEqual({ ...trashed, folderId: null });
  });

  it("keeps the folder of the pages in the trash when the folder has a subfolder", async () => {
    const folder = await insertFolder({ spaceId: everyone.id });
    await insertFolder({ spaceId: everyone.id, parentId: folder.id });
    const trashed = await insertPage({ spaceId: everyone.id, folderId: folder.id, deletedAt: T0 });
    const res = await send(`/api/v1/folders/${folder.id}`, { method: "DELETE", cookies: memberCookies });
    expect(res.status).toBe(409);
    expect(await readFolder(folder.id)).toEqual(folder);
    expect(await readPage(trashed.id)).toEqual(trashed);
  });
});

describe("deleting spaces with pages in the trash", () => {
  it("returns 409 space_not_empty for a space with only pages in the trash", async () => {
    const space = await insertSpace("everyone", "Trash only");
    await insertPage({ spaceId: space.id, deletedAt: T0 });
    const res = await send(`/api/v1/spaces/${space.id}`, { method: "DELETE", cookies: adminCookies });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("space_not_empty");
  });
});

describe("purgeExpiredTrash", () => {
  it("deletes the pages in the trash for 30 days with their revisions and returns the count", async () => {
    const now = T0 + 40 * DAY;
    const expired = await insertPage({ spaceId: everyone.id, deletedAt: now - TRASH_RETENTION_MS });
    const recent = await insertPage({ spaceId: everyone.id, deletedAt: now - TRASH_RETENTION_MS + 1 });
    // A revision of the expired page, kept until the page is deleted.
    await env.DB.prepare(
      "INSERT INTO page_revisions (id, page_id, version, title, body, created_by, created_at) VALUES (?, ?, 1, 'T', 'B', NULL, ?)",
    )
      .bind(crypto.randomUUID(), expired.id, T0)
      .run();

    expect(await purgeExpiredTrash(appDb, now)).toBe(1);
    expect(await readPage(expired.id)).toBeUndefined();
    expect(await countRevisions(expired.id)).toBe(0);
    expect(await readPage(recent.id)).toEqual(recent);
    expect(await readPage(page.id)).toEqual(page);
    expect(await purgeExpiredTrash(appDb, now)).toBe(0);
  });
});

describe("scheduled handler", () => {
  it("deletes the pages that have been in the trash for 30 days", async () => {
    const now = T0 + 40 * DAY;
    setNow(now);
    const expired = await insertPage({ spaceId: everyone.id, deletedAt: now - 31 * DAY });
    const recent = await insertPage({ spaceId: everyone.id, deletedAt: now - DAY });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const controller = createScheduledController({ scheduledTime: now, cron: "0 18 * * *" });
    await worker.scheduled(controller, env, createExecutionContext());

    expect(await readPage(expired.id)).toBeUndefined();
    expect(await readPage(recent.id)).toEqual(recent);
    expect(await readPage(page.id)).toEqual(page);
    expect(log).toHaveBeenCalledWith("purged trash", { count: 1 });
  });
});
