import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Folder, FolderList, Page, PageList, SearchResult } from "../src/api/types";
import { clock } from "@i2bskn/workers-app-core";
import { folders, pages, spaces, type FolderRow, type PageRow, type SpaceRow, type UserRow } from "../src/db/schema";
import {
  countFolders,
  countPages,
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
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

async function errorBody(res: Response): Promise<{ code: string; message: string }> {
  return ((await res.json()) as { error: { code: string; message: string } }).error;
}

async function errorCode(res: Response): Promise<string> {
  return (await errorBody(res)).code;
}

function readFolder(id: string): Promise<FolderRow | undefined> {
  return db.query.folders.findFirst({ where: eq(folders.id, id) });
}

function readPage(id: string): Promise<PageRow | undefined> {
  return db.query.pages.findFirst({ where: eq(pages.id, id) });
}

function postFolder(spaceId: string, cookies: SessionCookies, json: unknown): Promise<Response> {
  return send(`/api/v1/spaces/${spaceId}/folders`, { cookies, json });
}

function patchFolder(id: string, cookies: SessionCookies, json: unknown): Promise<Response> {
  return send(`/api/v1/folders/${id}`, { method: "PATCH", cookies, json });
}

function deleteFolder(id: string, cookies: SessionCookies): Promise<Response> {
  return send(`/api/v1/folders/${id}`, { method: "DELETE", cookies });
}

function postPage(spaceId: string, cookies: SessionCookies, json: unknown): Promise<Response> {
  return send(`/api/v1/spaces/${spaceId}/pages`, { cookies, json });
}

function patchPage(id: string, cookies: SessionCookies, json: unknown): Promise<Response> {
  return send(`/api/v1/pages/${id}`, { method: "PATCH", cookies, json });
}

let admin: UserRow;
let member: UserRow;
let adminCookies: SessionCookies;
let memberCookies: SessionCookies;
let everyone: SpaceRow;
let other: SpaceRow;
let adminOnly: SpaceRow;

beforeEach(async () => {
  await resetDb();
  setNow(T0);
  admin = await createUser({ email: "admin@example.com", role: "admin", createdAt: T0 });
  member = await createUser({ email: "member@example.com", role: "member", createdAt: T0 });
  adminCookies = await login(admin.email);
  memberCookies = await login(member.email);
  everyone = await insertSpace("everyone", "Everyone");
  other = await insertSpace("everyone", "Other");
  adminOnly = await insertSpace("admin", "Admins");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/v1/spaces/:id/folders", () => {
  it("creates a folder at the top level with a trimmed name", async () => {
    const res = await postFolder(everyone.id, memberCookies, { name: "  Docs  " });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Folder;
    expect(body).toEqual({
      id: expect.stringMatching(UUID_V4),
      space_id: everyone.id,
      parent_id: null,
      name: "Docs",
      created_by: member.id,
      updated_by: member.id,
      created_at: T0,
      updated_at: T0,
    });
    expect(await readFolder(body.id)).toMatchObject({ spaceId: everyone.id, parentId: null, name: "Docs" });
  });

  it("creates a folder inside another folder, and accepts null as the top level", async () => {
    const parent = await insertFolder({ spaceId: everyone.id });
    const child = await postFolder(everyone.id, memberCookies, { name: "Child", parent_id: parent.id });
    expect(child.status).toBe(201);
    expect(((await child.json()) as Folder).parent_id).toBe(parent.id);
    const top = await postFolder(everyone.id, memberCookies, { name: "Top", parent_id: null });
    expect(top.status).toBe(201);
    expect(((await top.json()) as Folder).parent_id).toBeNull();
  });

  it("allows the same name twice in the same parent", async () => {
    expect((await postFolder(everyone.id, memberCookies, { name: "Same" })).status).toBe(201);
    expect((await postFolder(everyone.id, memberCookies, { name: "Same" })).status).toBe(201);
    expect(await countFolders()).toBe(2);
  });

  it("accepts a name of exactly 100 characters", async () => {
    const res = await postFolder(everyone.id, memberCookies, { name: "あ".repeat(100) });
    expect(res.status).toBe(201);
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["101 characters", "a".repeat(101)],
    ["a line break", "a\nb"],
    ["a lone surrogate", "a\uD800b"],
    ["a number", 1],
    ["missing", undefined],
  ])("rejects a name that is %s", async (_, name) => {
    const res = await postFolder(everyone.id, memberCookies, { name });
    expect(res.status).toBe(400);
    expect(await errorBody(res)).toEqual({
      code: "invalid_name",
      message: "フォルダの名前は 1 文字以上 100 文字以下で、改行などの制御文字を含まない文字列にしてください",
    });
    expect(await countFolders()).toBe(0);
  });

  it.each([
    ["an empty string", ""],
    ["a number", 1],
    ["an object", {}],
  ])("rejects parent_id that is %s", async (_, parentId) => {
    const res = await postFolder(everyone.id, memberCookies, { name: "Docs", parent_id: parentId });
    expect(res.status).toBe(400);
    expect(await errorBody(res)).toEqual({
      code: "invalid_parent_id",
      message: "parent_id はフォルダの id か null で指定してください",
    });
    expect(await countFolders()).toBe(0);
  });

  it("checks the name before parent_id", async () => {
    const res = await postFolder(everyone.id, memberCookies, { name: "", parent_id: 1 });
    expect(await errorCode(res)).toBe("invalid_name");
  });

  it("returns 400 parent_not_found for a parent in another space, an inaccessible space or none", async () => {
    const elsewhere = await insertFolder({ spaceId: other.id });
    const inAdminSpace = await insertFolder({ spaceId: adminOnly.id });
    const inOthersPersonal = await insertFolder({ spaceId: (await personalSpaceOf(admin)).id });
    for (const parentId of [elsewhere.id, inAdminSpace.id, inOthersPersonal.id, "missing"]) {
      const res = await postFolder(everyone.id, memberCookies, { name: "Docs", parent_id: parentId });
      expect(res.status).toBe(400);
      expect(await errorBody(res)).toEqual({ code: "parent_not_found", message: "親フォルダが見つかりません" });
    }
    expect(await countFolders()).toBe(3);
  });

  it("returns 404 for inaccessible and unknown spaces", async () => {
    for (const spaceId of [adminOnly.id, (await personalSpaceOf(admin)).id, "missing"]) {
      const res = await postFolder(spaceId, memberCookies, { name: "Docs" });
      expect(res.status).toBe(404);
      expect(await errorBody(res)).toEqual({ code: "not_found", message: "スペースが見つかりません" });
    }
    expect(await countFolders()).toBe(0);
  });

  it("creates a folder in the user's personal space", async () => {
    const personal = await personalSpaceOf(member);
    expect((await postFolder(personal.id, memberCookies, { name: "Mine" })).status).toBe(201);
  });

  it("returns 400 invalid_body for a body that is not an object", async () => {
    const res = await postFolder(everyone.id, memberCookies, "[]");
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("invalid_body");
  });

  it("returns 401 without a session", async () => {
    expect((await send(`/api/v1/spaces/${everyone.id}/folders`, { json: { name: "Docs" } })).status).toBe(401);
  });
});

describe("GET /api/v1/spaces/:id/folders", () => {
  it("lists all folders of the space as a flat list by name and id", async () => {
    const b = await insertFolder({ spaceId: everyone.id, name: "b" });
    const upper = await insertFolder({ spaceId: everyone.id, name: "B" });
    const nested = await insertFolder({ spaceId: everyone.id, parentId: b.id, name: "a" });
    await insertFolder({ spaceId: other.id, name: "Elsewhere" });

    const res = await send(`/api/v1/spaces/${everyone.id}/folders`, { cookies: memberCookies });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FolderList;
    // Binary comparison: uppercase letters come before lowercase ones.
    expect(body.folders.map((f) => f.id)).toEqual([upper.id, nested.id, b.id]);
    expect(body.folders[1]).toEqual({
      id: nested.id,
      space_id: everyone.id,
      parent_id: b.id,
      name: "a",
      created_by: null,
      updated_by: null,
      created_at: nested.createdAt,
      updated_at: nested.updatedAt,
    });
  });

  it("orders folders with the same name by id", async () => {
    const first = await insertFolder({ spaceId: everyone.id, name: "Same" });
    const second = await insertFolder({ spaceId: everyone.id, name: "Same" });
    const res = await send(`/api/v1/spaces/${everyone.id}/folders`, { cookies: memberCookies });
    const ids = ((await res.json()) as FolderList).folders.map((f) => f.id);
    expect(ids).toEqual([first.id, second.id].sort());
  });

  it("returns 404 for inaccessible and unknown spaces", async () => {
    for (const [cookies, spaceId] of [
      [memberCookies, adminOnly.id],
      [memberCookies, (await personalSpaceOf(admin)).id],
      [adminCookies, (await personalSpaceOf(member)).id],
      [adminCookies, "missing"],
    ] as const) {
      const res = await send(`/api/v1/spaces/${spaceId}/folders`, { cookies });
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe("not_found");
    }
  });
});

describe("GET /api/v1/folders/:id", () => {
  it("returns the folder", async () => {
    const folder = await insertFolder({ spaceId: everyone.id, name: "Docs", createdBy: admin.id, at: T0 });
    const res = await send(`/api/v1/folders/${folder.id}`, { cookies: memberCookies });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: folder.id,
      space_id: everyone.id,
      parent_id: null,
      name: "Docs",
      created_by: admin.id,
      updated_by: admin.id,
      created_at: T0,
      updated_at: T0,
    });
  });

  it("returns 404 for folders in inaccessible spaces and unknown folders", async () => {
    const inAdminSpace = await insertFolder({ spaceId: adminOnly.id });
    const inOthersPersonal = await insertFolder({ spaceId: (await personalSpaceOf(admin)).id });
    for (const id of [inAdminSpace.id, inOthersPersonal.id, "missing"]) {
      const res = await send(`/api/v1/folders/${id}`, { cookies: memberCookies });
      expect(res.status).toBe(404);
      expect(await errorBody(res)).toEqual({ code: "not_found", message: "フォルダが見つかりません" });
    }
    expect((await send(`/api/v1/folders/${inAdminSpace.id}`, { cookies: adminCookies })).status).toBe(200);
  });

  it("returns 401 without a session", async () => {
    const folder = await insertFolder({ spaceId: everyone.id });
    expect((await send(`/api/v1/folders/${folder.id}`)).status).toBe(401);
  });
});

describe("PATCH /api/v1/folders/:id", () => {
  let folder: FolderRow;

  beforeEach(async () => {
    folder = await insertFolder({ spaceId: everyone.id, name: "Docs", createdBy: admin.id, at: T0 });
  });

  it("renames the folder and updates updated_by and updated_at", async () => {
    setNow(T0 + 1000);
    const res = await patchFolder(folder.id, memberCookies, { name: "  Guides  " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: folder.id,
      space_id: everyone.id,
      parent_id: null,
      name: "Guides",
      created_by: admin.id,
      updated_by: member.id,
      created_at: T0,
      updated_at: T0 + 1000,
    });
    expect(await readFolder(folder.id)).toMatchObject({ name: "Guides", updatedBy: member.id, updatedAt: T0 + 1000 });
  });

  it("updates updated_at even if nothing changed", async () => {
    setNow(T0 + 1000);
    const res = await patchFolder(folder.id, memberCookies, { name: "Docs", parent_id: null });
    expect(res.status).toBe(200);
    expect(await readFolder(folder.id)).toMatchObject({ name: "Docs", updatedBy: member.id, updatedAt: T0 + 1000 });
  });

  it("moves the folder into another folder and back to the top level", async () => {
    const target = await insertFolder({ spaceId: everyone.id, name: "Target" });
    const moved = await patchFolder(folder.id, memberCookies, { parent_id: target.id });
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as Folder).parent_id).toBe(target.id);
    expect(await readFolder(folder.id)).toMatchObject({ parentId: target.id, name: "Docs" });

    const top = await patchFolder(folder.id, memberCookies, { parent_id: null });
    expect(top.status).toBe(200);
    expect(await readFolder(folder.id)).toMatchObject({ parentId: null, name: "Docs" });
  });

  it("renames and moves at once", async () => {
    const target = await insertFolder({ spaceId: everyone.id, name: "Target" });
    const res = await patchFolder(folder.id, memberCookies, { name: "New", parent_id: target.id });
    expect(res.status).toBe(200);
    expect(await readFolder(folder.id)).toMatchObject({ parentId: target.id, name: "New" });
  });

  it("keeps the parent when parent_id is omitted", async () => {
    const parent = await insertFolder({ spaceId: everyone.id, name: "Parent" });
    const child = await insertFolder({ spaceId: everyone.id, parentId: parent.id, name: "Child" });
    expect((await patchFolder(child.id, memberCookies, { name: "Renamed" })).status).toBe(200);
    expect(await readFolder(child.id)).toMatchObject({ parentId: parent.id, name: "Renamed" });
  });

  it("returns 409 folder_cycle for the folder itself as its parent", async () => {
    const res = await patchFolder(folder.id, memberCookies, { parent_id: folder.id });
    expect(res.status).toBe(409);
    expect(await errorBody(res)).toEqual({
      code: "folder_cycle",
      message: "フォルダを自分自身やその中のフォルダへは移せません",
    });
    expect(await readFolder(folder.id)).toEqual(folder);
  });

  it("returns 409 folder_cycle for a descendant two or more levels down", async () => {
    const child = await insertFolder({ spaceId: everyone.id, parentId: folder.id, name: "Child" });
    const grandchild = await insertFolder({ spaceId: everyone.id, parentId: child.id, name: "Grandchild" });
    const greatGrandchild = await insertFolder({ spaceId: everyone.id, parentId: grandchild.id, name: "Deep" });
    for (const target of [child, grandchild, greatGrandchild]) {
      const res = await patchFolder(folder.id, memberCookies, { parent_id: target.id });
      expect(res.status).toBe(409);
      expect(await errorCode(res)).toBe("folder_cycle");
    }
    expect(await readFolder(folder.id)).toEqual(folder);
    // Moving a descendant up is not a cycle.
    expect((await patchFolder(greatGrandchild.id, memberCookies, { parent_id: folder.id })).status).toBe(200);
  });

  it("returns 400 parent_not_found for a parent in another space, an inaccessible space or none", async () => {
    const elsewhere = await insertFolder({ spaceId: other.id });
    const inAdminSpace = await insertFolder({ spaceId: adminOnly.id });
    const inOthersPersonal = await insertFolder({ spaceId: (await personalSpaceOf(admin)).id });
    for (const parentId of [elsewhere.id, inAdminSpace.id, inOthersPersonal.id, "missing"]) {
      const res = await patchFolder(folder.id, memberCookies, { parent_id: parentId });
      expect(res.status).toBe(400);
      expect(await errorBody(res)).toEqual({ code: "parent_not_found", message: "移動先のフォルダが見つかりません" });
    }
    expect(await readFolder(folder.id)).toEqual(folder);
  });

  it("returns 400 empty_update without name and parent_id", async () => {
    const res = await patchFolder(folder.id, memberCookies, {});
    expect(res.status).toBe(400);
    expect(await errorBody(res)).toEqual({
      code: "empty_update",
      message: "name か parent_id のどちらかを指定してください",
    });
  });

  it("validates in the order empty_update, name, parent_id", async () => {
    expect(await errorCode(await patchFolder(folder.id, memberCookies, { name: "", parent_id: "" }))).toBe(
      "invalid_name",
    );
    expect(await errorCode(await patchFolder(folder.id, memberCookies, { name: "OK", parent_id: "" }))).toBe(
      "invalid_parent_id",
    );
    expect(await errorCode(await patchFolder(folder.id, memberCookies, { parent_id: 1 }))).toBe("invalid_parent_id");
    expect(await readFolder(folder.id)).toEqual(folder);
  });

  it("returns 404 for folders in inaccessible spaces and changes nothing", async () => {
    const parentInAdmin = await insertFolder({ spaceId: adminOnly.id, name: "Parent" });
    const inAdminSpace = await insertFolder({ spaceId: adminOnly.id, name: "Secret" });
    const inOthersPersonal = await insertFolder({ spaceId: (await personalSpaceOf(admin)).id, name: "Own" });
    for (const target of [inAdminSpace, inOthersPersonal]) {
      const res = await patchFolder(target.id, memberCookies, { name: "Changed", parent_id: parentInAdmin.id });
      expect(res.status).toBe(404);
      expect(await errorBody(res)).toEqual({ code: "not_found", message: "フォルダが見つかりません" });
      expect(await readFolder(target.id)).toEqual(target);
    }
    expect((await patchFolder("missing", memberCookies, { name: "Changed" })).status).toBe(404);
  });
});

describe("DELETE /api/v1/folders/:id", () => {
  it("deletes an empty folder", async () => {
    const folder = await insertFolder({ spaceId: everyone.id });
    const res = await deleteFolder(folder.id, memberCookies);
    expect(res.status).toBe(204);
    expect(await readFolder(folder.id)).toBeUndefined();
    expect((await deleteFolder(folder.id, memberCookies)).status).toBe(404);
  });

  it("returns 409 folder_not_empty for a folder with a subfolder and keeps both", async () => {
    const folder = await insertFolder({ spaceId: everyone.id });
    const child = await insertFolder({ spaceId: everyone.id, parentId: folder.id });
    const res = await deleteFolder(folder.id, memberCookies);
    expect(res.status).toBe(409);
    expect(await errorBody(res)).toEqual({
      code: "folder_not_empty",
      message: "中にページかフォルダがあるフォルダは削除できません。中身を移すか削除してから消してください",
    });
    expect(await readFolder(folder.id)).toEqual(folder);
    expect(await readFolder(child.id)).toEqual(child);
  });

  it("returns 409 folder_not_empty for a folder with a page and keeps both", async () => {
    const folder = await insertFolder({ spaceId: everyone.id });
    const page = await insertPage({ spaceId: everyone.id, folderId: folder.id });
    const res = await deleteFolder(folder.id, memberCookies);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("folder_not_empty");
    expect(await readFolder(folder.id)).toEqual(folder);
    expect(await readPage(page.id)).toEqual(page);
  });

  it("returns 404 for folders in inaccessible spaces and unknown folders", async () => {
    const inAdminSpace = await insertFolder({ spaceId: adminOnly.id });
    const inOthersPersonal = await insertFolder({ spaceId: (await personalSpaceOf(admin)).id });
    for (const id of [inAdminSpace.id, inOthersPersonal.id, "missing"]) {
      const res = await deleteFolder(id, memberCookies);
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe("not_found");
    }
    expect(await countFolders()).toBe(2);
  });
});

describe("pages in folders", () => {
  let folder: FolderRow;

  beforeEach(async () => {
    folder = await insertFolder({ spaceId: everyone.id, name: "Docs" });
  });

  describe("POST /api/v1/spaces/:id/pages", () => {
    it("creates a page in a folder", async () => {
      const res = await postPage(everyone.id, memberCookies, { title: "T", body: "", folder_id: folder.id });
      expect(res.status).toBe(201);
      const page = (await res.json()) as Page;
      expect(page.folder_id).toBe(folder.id);
      expect(await readPage(page.id)).toMatchObject({ folderId: folder.id });
    });

    it("creates a page at the top level when folder_id is null or omitted", async () => {
      for (const json of [{ title: "T", body: "", folder_id: null }, { title: "T", body: "" }]) {
        const res = await postPage(everyone.id, memberCookies, json);
        expect(res.status).toBe(201);
        expect(((await res.json()) as Page).folder_id).toBeNull();
      }
    });

    it("returns 400 folder_not_found for a folder in another space, an inaccessible space or none", async () => {
      const elsewhere = await insertFolder({ spaceId: other.id });
      const inAdminSpace = await insertFolder({ spaceId: adminOnly.id });
      const inOthersPersonal = await insertFolder({ spaceId: (await personalSpaceOf(admin)).id });
      for (const folderId of [elsewhere.id, inAdminSpace.id, inOthersPersonal.id, "missing"]) {
        const res = await postPage(everyone.id, memberCookies, { title: "T", body: "", folder_id: folderId });
        expect(res.status).toBe(400);
        expect(await errorBody(res)).toEqual({ code: "folder_not_found", message: "フォルダが見つかりません" });
      }
      expect(await countPages()).toBe(0);
    });

    it.each([
      ["an empty string", ""],
      ["a number", 1],
    ])("rejects folder_id that is %s after the title and the body", async (_, folderId) => {
      const res = await postPage(everyone.id, memberCookies, { title: "T", body: "", folder_id: folderId });
      expect(res.status).toBe(400);
      expect(await errorBody(res)).toEqual({
        code: "invalid_folder_id",
        message: "folder_id はフォルダの id か null で指定してください",
      });
      expect(await errorCode(await postPage(everyone.id, memberCookies, { title: "", folder_id: folderId }))).toBe(
        "invalid_title",
      );
      expect(await errorCode(await postPage(everyone.id, memberCookies, { title: "T", folder_id: folderId }))).toBe(
        "invalid_page_body",
      );
      expect(await countPages()).toBe(0);
    });

    it("returns 404 for an inaccessible space before checking the folder", async () => {
      const res = await postPage(adminOnly.id, memberCookies, { title: "T", body: "", folder_id: "missing" });
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe("not_found");
    });
  });

  describe("PATCH /api/v1/pages/:id", () => {
    let page: PageRow;

    beforeEach(async () => {
      page = await insertPage({ spaceId: everyone.id, title: "Title", body: "Body", createdBy: admin.id, at: T0 });
    });

    it("moves the page into a folder and increments the version", async () => {
      setNow(T0 + 1000);
      const res = await patchPage(page.id, memberCookies, { version: 1, folder_id: folder.id });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id: page.id,
        folder_id: folder.id,
        title: "Title",
        body: "Body",
        version: 2,
        updated_by: member.id,
        updated_at: T0 + 1000,
      });
      expect(await readPage(page.id)).toMatchObject({ folderId: folder.id, version: 2 });
    });

    it("moves the page back to the top level with null", async () => {
      await patchPage(page.id, memberCookies, { version: 1, folder_id: folder.id });
      const res = await patchPage(page.id, memberCookies, { version: 2, folder_id: null });
      expect(res.status).toBe(200);
      expect(await readPage(page.id)).toMatchObject({ folderId: null, version: 3 });
    });

    it("keeps the folder when folder_id is omitted", async () => {
      await patchPage(page.id, memberCookies, { version: 1, folder_id: folder.id });
      expect((await patchPage(page.id, memberCookies, { version: 2, title: "New" })).status).toBe(200);
      expect(await readPage(page.id)).toMatchObject({ folderId: folder.id, title: "New", version: 3 });
    });

    it("returns 400 folder_not_found for a folder in another space, an inaccessible space or none", async () => {
      const elsewhere = await insertFolder({ spaceId: other.id });
      const inAdminSpace = await insertFolder({ spaceId: adminOnly.id });
      const inOthersPersonal = await insertFolder({ spaceId: (await personalSpaceOf(admin)).id });
      for (const folderId of [elsewhere.id, inAdminSpace.id, inOthersPersonal.id, "missing"]) {
        const res = await patchPage(page.id, memberCookies, { version: 1, folder_id: folderId });
        expect(res.status).toBe(400);
        expect(await errorBody(res)).toEqual({ code: "folder_not_found", message: "フォルダが見つかりません" });
      }
      expect(await readPage(page.id)).toEqual(page);
    });

    it("reports a version conflict before a missing folder", async () => {
      const res = await patchPage(page.id, memberCookies, { version: 5, folder_id: "missing" });
      expect(res.status).toBe(409);
      expect(await errorCode(res)).toBe("version_conflict");
      expect(await readPage(page.id)).toEqual(page);
    });

    it("validates in the order version, empty_update, title, body, folder_id", async () => {
      const cases: [unknown, string][] = [
        [{ version: 0, folder_id: "" }, "invalid_version"],
        [{ version: 1 }, "empty_update"],
        [{ version: 1, title: "", folder_id: "" }, "invalid_title"],
        [{ version: 1, body: 1, folder_id: "" }, "invalid_page_body"],
        [{ version: 1, folder_id: "" }, "invalid_folder_id"],
        [{ version: 1, folder_id: 1 }, "invalid_folder_id"],
      ];
      for (const [json, code] of cases) {
        expect(await errorCode(await patchPage(page.id, memberCookies, json))).toBe(code);
      }
      expect(await readPage(page.id)).toEqual(page);
    });

    it("returns the new empty_update message", async () => {
      const res = await patchPage(page.id, memberCookies, { version: 1 });
      expect(await errorBody(res)).toEqual({
        code: "empty_update",
        message: "title、body、folder_id のいずれかを指定してください",
      });
    });
  });

  it("includes folder_id in the page list, the page and search hits", async () => {
    const inFolder = await insertPage({ spaceId: everyone.id, folderId: folder.id, title: "Inside", at: T0 + 1 });
    const top = await insertPage({ spaceId: everyone.id, title: "Outside", at: T0 });

    const list = (await (await send(`/api/v1/spaces/${everyone.id}/pages`, { cookies: memberCookies })).json()) as PageList;
    expect(list.pages.map((p) => [p.id, p.folder_id])).toEqual([
      [inFolder.id, folder.id],
      [top.id, null],
    ]);

    const page = (await (await send(`/api/v1/pages/${inFolder.id}`, { cookies: memberCookies })).json()) as Page;
    expect(page.folder_id).toBe(folder.id);

    const search = (await (await send("/api/v1/search?q=side", { cookies: memberCookies })).json()) as SearchResult;
    expect(search.hits.map((h) => [h.id, h.folder_id])).toEqual([
      [inFolder.id, folder.id],
      [top.id, null],
    ]);
  });
});
