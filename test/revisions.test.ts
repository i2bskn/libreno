import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import type { Page, PageRevision, PageRevisionList } from "../src/api/types";
import { clock } from "@i2bskn/workers-app-core";
import { pageRevisions, pages, spaces, type PageRow, type SpaceRow, type UserRow } from "../src/db/schema";
import {
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
const pageNotFound = "ページが見つかりません";
const revisionNotFound = "この版は見つかりません。古い版は新しい 20 版を残して削除されます";

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

function patchPage(id: string, cookies: SessionCookies, json: unknown): Promise<Response> {
  return send(`/api/v1/pages/${id}`, { method: "PATCH", cookies, json });
}

function restore(id: string, revision: string | number, cookies: SessionCookies, json: unknown): Promise<Response> {
  return send(`/api/v1/pages/${id}/revisions/${revision}/restore`, { cookies, json });
}

function readPage(id: string): Promise<PageRow | undefined> {
  return db.query.pages.findFirst({ where: eq(pages.id, id) });
}

function readRevisions(pageId: string) {
  return db
    .select()
    .from(pageRevisions)
    .where(eq(pageRevisions.pageId, pageId))
    .orderBy(asc(pageRevisions.version))
    .all();
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
  page = await insertPage({ spaceId: everyone.id, title: "Title 1", body: "Body 1", createdBy: admin.id, at: T0 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("keeping revisions on update", () => {
  it("keeps the title, body, version, updater and time before a title update", async () => {
    setNow(T0 + 1000);
    const res = await patchPage(page.id, memberCookies, { version: 1, title: "Title 2" });
    expect(res.status).toBe(200);
    expect(await readRevisions(page.id)).toEqual([
      {
        id: expect.any(String),
        pageId: page.id,
        version: 1,
        title: "Title 1",
        body: "Body 1",
        createdBy: admin.id,
        createdAt: T0,
      },
    ]);
    expect(await readPage(page.id)).toMatchObject({ title: "Title 2", body: "Body 1", version: 2 });
  });

  it("keeps a revision on a body update, with the values of the previous update", async () => {
    setNow(T0 + 1000);
    expect((await patchPage(page.id, memberCookies, { version: 1, title: "Title 2" })).status).toBe(200);
    setNow(T0 + 2000);
    expect((await patchPage(page.id, adminCookies, { version: 2, body: "Body 2" })).status).toBe(200);
    const revisions = await readRevisions(page.id);
    expect(revisions).toHaveLength(2);
    expect(revisions[1]).toMatchObject({
      version: 2,
      title: "Title 2",
      body: "Body 1",
      createdBy: member.id,
      createdAt: T0 + 1000,
    });
  });

  it("keeps a revision even if the values do not change", async () => {
    const res = await patchPage(page.id, memberCookies, { version: 1, title: "Title 1", body: "Body 1" });
    expect(res.status).toBe(200);
    expect(await readRevisions(page.id)).toHaveLength(1);
  });

  it("keeps no revision when only the folder changes, but increments the version", async () => {
    const folder = await insertFolder({ spaceId: everyone.id });
    const res = await patchPage(page.id, memberCookies, { version: 1, folder_id: folder.id });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Page).version).toBe(2);
    expect(await readRevisions(page.id)).toEqual([]);
  });

  it("keeps one revision when the title and the folder change together", async () => {
    const folder = await insertFolder({ spaceId: everyone.id });
    const res = await patchPage(page.id, memberCookies, { version: 1, title: "Title 2", folder_id: folder.id });
    expect(res.status).toBe(200);
    expect(await readRevisions(page.id)).toEqual([expect.objectContaining({ version: 1, title: "Title 1" })]);
  });

  it("keeps no revision when the update fails with a version conflict", async () => {
    expect((await patchPage(page.id, memberCookies, { version: 1, body: "first" })).status).toBe(200);
    const res = await patchPage(page.id, memberCookies, { version: 1, body: "second" });
    expect(res.status).toBe(409);
    expect(await readRevisions(page.id)).toHaveLength(1);
  });

  it("keeps no revision when the folder is not found", async () => {
    const otherSpace = await insertSpace("everyone", "Other");
    const otherFolder = await insertFolder({ spaceId: otherSpace.id });
    const res = await patchPage(page.id, memberCookies, { version: 1, title: "Title 2", folder_id: otherFolder.id });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("folder_not_found");
    expect(await readRevisions(page.id)).toEqual([]);
    expect(await readPage(page.id)).toEqual(page);
  });

  it("keeps the newest 20 revisions", async () => {
    for (let version = 1; version <= 22; version++) {
      const res = await patchPage(page.id, memberCookies, { version, body: `Body ${version + 1}` });
      expect(res.status).toBe(200);
    }
    const revisions = await readRevisions(page.id);
    expect(revisions.map((r) => r.version)).toEqual(Array.from({ length: 20 }, (_, i) => i + 3));
    expect((await readPage(page.id))?.version).toBe(23);
  });

  it("does not prune the revisions of other pages", async () => {
    const other = await insertPage({ spaceId: everyone.id, title: "Other", body: "" });
    expect((await patchPage(other.id, memberCookies, { version: 1, body: "x" })).status).toBe(200);
    for (let version = 1; version <= 21; version++) {
      expect((await patchPage(page.id, memberCookies, { version, body: `${version}` })).status).toBe(200);
    }
    expect(await readRevisions(other.id)).toHaveLength(1);
    expect(await readRevisions(page.id)).toHaveLength(20);
  });

  it("keeps the revisions when the page is moved to the trash, and deletes them with the page", async () => {
    expect((await patchPage(page.id, memberCookies, { version: 1, body: "x" })).status).toBe(200);
    expect((await send(`/api/v1/pages/${page.id}`, { method: "DELETE", cookies: memberCookies })).status).toBe(204);
    const count = async () =>
      (await env.DB.prepare("SELECT COUNT(*) AS count FROM page_revisions").first<{ count: number }>())?.count;
    expect(await count()).toBe(1);
    expect(
      (await send(`/api/v1/pages/${page.id}/permanent`, { method: "DELETE", cookies: adminCookies })).status,
    ).toBe(204);
    expect(await count()).toBe(0);
  });
});

describe("GET /api/v1/pages/:id/revisions", () => {
  it("lists the revisions newest first without their bodies", async () => {
    setNow(T0 + 1000);
    expect((await patchPage(page.id, memberCookies, { version: 1, title: "Title 2" })).status).toBe(200);
    setNow(T0 + 2000);
    expect((await patchPage(page.id, adminCookies, { version: 2, body: "Body 3" })).status).toBe(200);

    const res = await send(`/api/v1/pages/${page.id}/revisions`, { cookies: memberCookies });
    expect(res.status).toBe(200);
    expect((await res.json()) as PageRevisionList).toEqual({
      revisions: [
        { version: 2, title: "Title 2", created_by: member.id, created_at: T0 + 1000 },
        { version: 1, title: "Title 1", created_by: admin.id, created_at: T0 },
      ],
    });
  });

  it("returns an empty list for a page without revisions", async () => {
    const res = await send(`/api/v1/pages/${page.id}/revisions`, { cookies: memberCookies });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revisions: [] });
  });

  it("returns 404 for pages in inaccessible spaces and unknown pages", async () => {
    const adminSpace = await insertSpace("admin", "Admins");
    const adminPage = await insertPage({ spaceId: adminSpace.id });
    const othersPage = await insertPage({ spaceId: (await personalSpaceOf(admin)).id });
    for (const id of [adminPage.id, othersPage.id, "missing"]) {
      const res = await send(`/api/v1/pages/${id}/revisions`, { cookies: memberCookies });
      expect(res.status).toBe(404);
      expect(await errorOf(res)).toEqual({ code: "not_found", message: pageNotFound });
    }
  });
});

describe("GET /api/v1/pages/:id/revisions/:version", () => {
  beforeEach(async () => {
    setNow(T0 + 1000);
    expect((await patchPage(page.id, memberCookies, { version: 1, title: "Title 2", body: "Body 2" })).status).toBe(200);
  });

  it("returns the revision with its body", async () => {
    const res = await send(`/api/v1/pages/${page.id}/revisions/1`, { cookies: memberCookies });
    expect(res.status).toBe(200);
    expect((await res.json()) as PageRevision).toEqual({
      page_id: page.id,
      version: 1,
      title: "Title 1",
      created_by: admin.id,
      created_at: T0,
      body: "Body 1",
    });
  });

  it.each(["3", "2", "0", "abc", "1.5", "01", "+1", "9999999999999999", "99999999999999999"])(
    "returns 404 revision_not_found for version %s",
    async (version) => {
      const res = await send(`/api/v1/pages/${page.id}/revisions/${version}`, { cookies: memberCookies });
      expect(res.status).toBe(404);
      expect(await errorOf(res)).toEqual({ code: "revision_not_found", message: revisionNotFound });
    },
  );

  it("does not return a revision of another page", async () => {
    const other = await insertPage({ spaceId: everyone.id, title: "Other", body: "" });
    const res = await send(`/api/v1/pages/${other.id}/revisions/1`, { cookies: memberCookies });
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("revision_not_found");
  });

  it("returns 404 not_found for pages in inaccessible spaces and unknown pages, even with an invalid version", async () => {
    const adminSpace = await insertSpace("admin", "Admins");
    const adminPage = await insertPage({ spaceId: adminSpace.id });
    expect((await patchPage(adminPage.id, adminCookies, { version: 1, body: "x" })).status).toBe(200);
    const othersPage = await insertPage({ spaceId: (await personalSpaceOf(admin)).id });
    expect((await patchPage(othersPage.id, adminCookies, { version: 1, body: "x" })).status).toBe(200);
    for (const id of [adminPage.id, othersPage.id, "missing"]) {
      for (const version of ["1", "abc"]) {
        const res = await send(`/api/v1/pages/${id}/revisions/${version}`, { cookies: memberCookies });
        expect(res.status).toBe(404);
        expect(await errorOf(res)).toEqual({ code: "not_found", message: pageNotFound });
      }
    }
  });
});

describe("POST /api/v1/pages/:id/revisions/:version/restore", () => {
  let folderPage: PageRow;

  beforeEach(async () => {
    const folder = await insertFolder({ spaceId: everyone.id });
    folderPage = await insertPage({ spaceId: everyone.id, folderId: folder.id, title: "Old", body: "Old body", at: T0 });
    setNow(T0 + 1000);
    expect((await patchPage(folderPage.id, adminCookies, { version: 1, title: "New", body: "New body" })).status).toBe(
      200,
    );
  });

  it("restores the title and body, keeps the current content as a revision and keeps the folder", async () => {
    setNow(T0 + 2000);
    const res = await restore(folderPage.id, 1, memberCookies, { version: 2 });
    expect(res.status).toBe(200);
    expect((await res.json()) as Page).toEqual({
      id: folderPage.id,
      space_id: everyone.id,
      folder_id: folderPage.folderId,
      title: "Old",
      body: "Old body",
      version: 3,
      created_by: null,
      updated_by: member.id,
      created_at: T0,
      updated_at: T0 + 2000,
    });
    expect((await readRevisions(folderPage.id)).map((r) => [r.version, r.title, r.body])).toEqual([
      [1, "Old", "Old body"],
      [2, "New", "New body"],
    ]);
  });

  it("returns 409 and changes nothing on a version conflict", async () => {
    const before = await readPage(folderPage.id);
    const res = await restore(folderPage.id, 1, memberCookies, { version: 1 });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("version_conflict");
    expect(await readPage(folderPage.id)).toEqual(before);
    expect(await readRevisions(folderPage.id)).toHaveLength(1);
  });

  it.each([{ version: 0 }, { version: 1.5 }, { version: "2" }, {}])("returns 400 invalid_version for %j", async (json) => {
    const res = await restore(folderPage.id, 1, memberCookies, json);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("invalid_version");
  });

  it("returns 400 invalid_body for a body that is not an object", async () => {
    const res = await restore(folderPage.id, 1, memberCookies, "[]");
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("invalid_body");
  });

  it("checks the body before the page", async () => {
    const res = await restore("missing", 1, memberCookies, { version: 0 });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("invalid_version");
  });

  it.each(["2", "3", "0", "abc", "1.5"])("returns 404 revision_not_found for version %s", async (version) => {
    const before = await readPage(folderPage.id);
    const res = await restore(folderPage.id, version, memberCookies, { version: 2 });
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toEqual({ code: "revision_not_found", message: revisionNotFound });
    expect(await readPage(folderPage.id)).toEqual(before);
  });

  it("returns 404 not_found for pages in inaccessible spaces and unknown pages", async () => {
    const adminSpace = await insertSpace("admin", "Admins");
    const adminPage = await insertPage({ spaceId: adminSpace.id, body: "a" });
    expect((await patchPage(adminPage.id, adminCookies, { version: 1, body: "b" })).status).toBe(200);
    const othersPage = await insertPage({ spaceId: (await personalSpaceOf(admin)).id, body: "a" });
    expect((await patchPage(othersPage.id, adminCookies, { version: 1, body: "b" })).status).toBe(200);
    for (const target of [adminPage, othersPage]) {
      const before = await readPage(target.id);
      const res = await restore(target.id, 1, memberCookies, { version: 2 });
      expect(res.status).toBe(404);
      expect(await errorOf(res)).toEqual({ code: "not_found", message: pageNotFound });
      expect(await readPage(target.id)).toEqual(before);
    }
    const res = await restore("missing", 1, memberCookies, { version: 1 });
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("not_found");
  });

  it("deletes the oldest revision when 20 are kept", async () => {
    for (let version = 2; version <= 20; version++) {
      expect((await patchPage(folderPage.id, memberCookies, { version, body: `Body ${version + 1}` })).status).toBe(200);
    }
    expect((await readRevisions(folderPage.id)).map((r) => r.version)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    const res = await restore(folderPage.id, 1, memberCookies, { version: 21 });
    expect(res.status).toBe(200);
    expect(await readPage(folderPage.id)).toMatchObject({ title: "Old", body: "Old body", version: 22 });
    expect((await readRevisions(folderPage.id)).map((r) => r.version)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 2),
    );
  });
});
