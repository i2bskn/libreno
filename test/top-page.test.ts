import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TopPage } from "../src/api/types";
import { clock } from "@i2bskn/workers-app-core";
import { pages, siteSettings, spaces, type PageRow, type SpaceRow, type UserRow } from "../src/db/schema";
import { purgeExpiredTrash, TRASH_RETENTION_MS } from "../src/pages/trash";
import { setTopPage } from "../src/pages/top-page";
import {
  appDb,
  createUser,
  db,
  dbChangingBefore,
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

function readSettings() {
  return db.query.siteSettings.findFirst({ where: eq(siteSettings.id, 1) });
}

function putTopPage(cookies: SessionCookies | undefined, json: unknown): Promise<Response> {
  return send("/api/v1/top-page", { method: "PUT", cookies, json });
}

async function getTopPageId(cookies: SessionCookies): Promise<string | null> {
  const res = await send("/api/v1/top-page", { cookies });
  expect(res.status).toBe(200);
  return ((await res.json()) as TopPage).page?.id ?? null;
}

function moveToSpace(pageId: string, spaceId: string) {
  return db.update(pages).set({ spaceId }).where(eq(pages.id, pageId)).run();
}

let admin: UserRow;
let member: UserRow;
let adminCookies: SessionCookies;
let memberCookies: SessionCookies;
let everyone: SpaceRow;
let adminSpace: SpaceRow;
let page: PageRow;

beforeEach(async () => {
  await resetDb();
  setNow(T0);
  admin = await createUser({ email: "admin@example.com", role: "admin", createdAt: T0 });
  member = await createUser({ email: "member@example.com", role: "member", createdAt: T0 });
  adminCookies = await login(admin.email);
  memberCookies = await login(member.email);
  everyone = await insertSpace("everyone", "Everyone");
  adminSpace = await insertSpace("admin", "Admins");
  page = await insertPage({ spaceId: everyone.id, title: "Links", body: "- [経費申請](/pages/x)", at: T0 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/v1/top-page", () => {
  it("returns null when nothing is set, for members and admins", async () => {
    for (const cookies of [memberCookies, adminCookies]) {
      const res = await send("/api/v1/top-page", { cookies });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ page: null });
    }
  });

  it("returns 401 without a session", async () => {
    const res = await send("/api/v1/top-page");
    expect(res.status).toBe(401);
  });
});

describe("PUT /api/v1/top-page", () => {
  it("sets a page in an everyone space, which every user then reads with its body", async () => {
    const res = await putTopPage(adminCookies, { page_id: page.id });
    expect(res.status).toBe(200);
    expect(((await res.json()) as TopPage).page).toMatchObject({ id: page.id, title: "Links" });
    expect(await readSettings()).toEqual({ id: 1, topPageId: page.id, updatedBy: admin.id, updatedAt: T0 });

    const got = await send("/api/v1/top-page", { cookies: memberCookies });
    expect(got.status).toBe(200);
    expect(((await got.json()) as TopPage).page).toMatchObject({
      id: page.id,
      title: "Links",
      body: "- [経費申請](/pages/x)",
    });
  });

  it("clears the setting with null", async () => {
    expect((await putTopPage(adminCookies, { page_id: page.id })).status).toBe(200);
    setNow(T0 + 1000);
    const res = await putTopPage(adminCookies, { page_id: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ page: null });
    expect(await readSettings()).toEqual({ id: 1, topPageId: null, updatedBy: admin.id, updatedAt: T0 + 1000 });
    expect(await getTopPageId(memberCookies)).toBeNull();
  });

  it("accepts null when nothing is set", async () => {
    const res = await putTopPage(adminCookies, { page_id: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ page: null });
  });

  it("returns 403 for a member and keeps the setting", async () => {
    expect((await putTopPage(adminCookies, { page_id: page.id })).status).toBe(200);
    const res = await putTopPage(memberCookies, { page_id: null });
    expect(res.status).toBe(403);
    expect(await readSettings()).toMatchObject({ topPageId: page.id });
  });

  it("returns 401 without a session", async () => {
    const res = await putTopPage(undefined, { page_id: page.id });
    expect(res.status).toBe(401);
    expect(await readSettings()).toBeUndefined();
  });

  it("returns 400 for a page in an admin space", async () => {
    const inAdmin = await insertPage({ spaceId: adminSpace.id });
    const res = await putTopPage(adminCookies, { page_id: inAdmin.id });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toEqual({
      code: "not_everyone_space",
      message: "トップに表示できるのは全員スペースのページだけです",
    });
    expect(await readSettings()).toBeUndefined();
  });

  it("returns 400 for a page in the admin's own personal space", async () => {
    const own = await insertPage({ spaceId: (await personalSpaceOf(admin)).id });
    const res = await putTopPage(adminCookies, { page_id: own.id });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("not_everyone_space");
    expect(await readSettings()).toBeUndefined();
  });

  it("returns 404 for a page in another user's personal space, a trashed page and an unknown id", async () => {
    const others = await insertPage({ spaceId: (await personalSpaceOf(member)).id });
    const trashed = await insertPage({ spaceId: everyone.id, deletedAt: T0, deletedBy: admin.id });
    for (const id of [others.id, trashed.id, crypto.randomUUID()]) {
      const res = await putTopPage(adminCookies, { page_id: id });
      expect(res.status).toBe(404);
      expect(await errorOf(res)).toEqual({ code: "not_found", message: pageNotFound });
    }
    expect(await readSettings()).toBeUndefined();
  });

  it.each([
    ["a number", { page_id: 1 }],
    ["a missing page_id", {}],
  ])("returns 400 for %s", async (_, json) => {
    const res = await putTopPage(adminCookies, json);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toEqual({ code: "invalid_page_id", message: "page_id は文字列か null にしてください" });
  });

  it("returns 400 for a body that is not a JSON object", async () => {
    const res = await putTopPage(adminCookies, "[]");
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("invalid_body");
  });
});

describe("the page after it is set", () => {
  beforeEach(async () => {
    expect((await putTopPage(adminCookies, { page_id: page.id })).status).toBe(200);
  });

  it("is hidden while it is in an admin space, for admins too, and shown again when moved back", async () => {
    await moveToSpace(page.id, adminSpace.id);
    expect(await getTopPageId(memberCookies)).toBeNull();
    expect(await getTopPageId(adminCookies)).toBeNull();
    await moveToSpace(page.id, everyone.id);
    expect(await getTopPageId(memberCookies)).toBe(page.id);
    expect(await getTopPageId(adminCookies)).toBe(page.id);
  });

  it("is hidden while it is in the trash and shown again when restored", async () => {
    expect((await send(`/api/v1/pages/${page.id}`, { method: "DELETE", cookies: memberCookies })).status).toBe(204);
    expect(await getTopPageId(memberCookies)).toBeNull();
    expect(await getTopPageId(adminCookies)).toBeNull();
    expect((await send(`/api/v1/pages/${page.id}/restore`, { method: "POST", cookies: memberCookies })).status).toBe(
      200,
    );
    expect(await getTopPageId(memberCookies)).toBe(page.id);
  });

  it("is cleared when it is deleted from the trash", async () => {
    expect((await send(`/api/v1/pages/${page.id}`, { method: "DELETE", cookies: adminCookies })).status).toBe(204);
    const res = await send(`/api/v1/pages/${page.id}/permanent`, { method: "DELETE", cookies: adminCookies });
    expect(res.status).toBe(204);
    expect(await readSettings()).toMatchObject({ topPageId: null, updatedBy: admin.id });
    expect(await getTopPageId(memberCookies)).toBeNull();
  });

  it("is cleared when the scheduled job deletes it from the trash", async () => {
    const now = T0 + 40 * DAY;
    await db
      .update(pages)
      .set({ deletedAt: now - TRASH_RETENTION_MS, deletedBy: admin.id })
      .where(eq(pages.id, page.id))
      .run();
    expect(await purgeExpiredTrash(appDb, now)).toBe(1);
    expect(await readSettings()).toMatchObject({ topPageId: null });
  });

  it("is kept when the admin who set it is deleted", async () => {
    const other = await createUser({ email: "other@example.com", role: "admin", createdAt: T0 });
    const otherCookies = await login(other.email);
    const res = await send(`/api/v1/users/${admin.id}`, { method: "DELETE", cookies: otherCookies });
    expect(res.status).toBe(204);
    expect(await readSettings()).toEqual({ id: 1, topPageId: page.id, updatedBy: null, updatedAt: T0 });
    expect(await getTopPageId(memberCookies)).toBe(page.id);
  });

  it("is cleared when it was moved to a personal space whose user is deleted", async () => {
    await moveToSpace(page.id, (await personalSpaceOf(member)).id);
    const res = await send(`/api/v1/users/${member.id}`, { method: "DELETE", cookies: adminCookies });
    expect(res.status).toBe(204);
    expect(await db.query.pages.findFirst({ where: eq(pages.id, page.id) })).toBeUndefined();
    expect(await readSettings()).toMatchObject({ topPageId: null, updatedBy: admin.id });
  });
});

describe("changes between the checks and the write", () => {
  it("does not set a page moved to an admin space right before the statement runs", async () => {
    const changing = dbChangingBefore(/INSERT INTO site_settings/i, () => moveToSpace(page.id, adminSpace.id));
    const result = await setTopPage(changing, admin, page.id);
    expect(result).toEqual({ ok: false, error: "not_everyone_space" });
    expect(await readSettings()).toBeUndefined();
  });

  it("does not replace the setting with a page moved to an admin space right before the statement runs", async () => {
    const first = await insertPage({ spaceId: everyone.id });
    expect((await setTopPage(appDb, admin, first.id)).ok).toBe(true);
    const changing = dbChangingBefore(/INSERT INTO site_settings/i, () => moveToSpace(page.id, adminSpace.id));
    const result = await setTopPage(changing, admin, page.id);
    expect(result).toEqual({ ok: false, error: "not_everyone_space" });
    expect(await readSettings()).toMatchObject({ topPageId: first.id });
  });

  it("does not set a page put in the trash right before the statement runs", async () => {
    const changing = dbChangingBefore(/INSERT INTO site_settings/i, () =>
      env.DB.prepare("UPDATE pages SET deleted_at = ?, deleted_by = ? WHERE id = ?").bind(T0, admin.id, page.id).run(),
    );
    const result = await setTopPage(changing, admin, page.id);
    expect(result).toEqual({ ok: false, error: "not_found" });
    expect(await readSettings()).toBeUndefined();
  });
});
