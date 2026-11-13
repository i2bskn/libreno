import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Folder, FolderList, Page, PageList, PageRevisionList, SearchResult, TrashList } from "../src/api/types";
import { clock } from "@i2bskn/workers-app-core";
import { folders, pages, spaces, type FolderRow, type PageRow, type SpaceRow, type UserRow } from "../src/db/schema";
import { createFolder, moveFolder } from "../src/folders/service";
import { createPage, movePage } from "../src/pages/service";
import {
  appDb,
  countFolders,
  countPages,
  createUser,
  db,
  dbChangingBefore,
  insertFolder,
  insertPage,
  login,
  resetDb,
  send,
  type SessionCookies,
} from "./helpers";

const T0 = Date.UTC(2026, 9, 1);
const T1 = T0 + 60_000;

function setNow(now: number) {
  vi.spyOn(clock, "now").mockReturnValue(now);
}

async function insertSpace(kind: "everyone" | "admin" | "members", name: string): Promise<SpaceRow> {
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

function readFolder(id: string): Promise<FolderRow | undefined> {
  return db.query.folders.findFirst({ where: eq(folders.id, id) });
}

function readPage(id: string): Promise<PageRow | undefined> {
  return db.query.pages.findFirst({ where: eq(pages.id, id) });
}

function postPageMove(id: string, cookies: SessionCookies, json: unknown): Promise<Response> {
  return send(`/api/v1/pages/${id}/move`, { cookies, json });
}

function postFolderMove(id: string, cookies: SessionCookies, json: unknown): Promise<Response> {
  return send(`/api/v1/folders/${id}/move`, { cookies, json });
}

async function getJson<T>(url: string, cookies: SessionCookies): Promise<T> {
  const res = await send(url, { cookies });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

const REST = { requireVisibilityAck: false, acknowledged: false };
const MCP_WITHOUT_ACK = { requireVisibilityAck: true, acknowledged: false };

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

describe("POST /api/v1/pages/:id/move", () => {
  it("moves a page to the top level of another space with its revisions", async () => {
    const folder = await insertFolder({ spaceId: everyone.id, at: T0 });
    const page = await insertPage({ spaceId: everyone.id, folderId: folder.id, title: "Old", body: "old", at: T0 });
    // Keeps a revision of version 1.
    const patched = await send(`/api/v1/pages/${page.id}`, {
      method: "PATCH",
      cookies: memberCookies,
      json: { version: 1, title: "New", body: "new" },
    });
    expect(patched.status).toBe(200);

    setNow(T1);
    const res = await postPageMove(page.id, memberCookies, { version: 2, space_id: other.id });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Page;
    expect(body).toMatchObject({
      id: page.id,
      space_id: other.id,
      folder_id: null,
      title: "New",
      body: "new",
      version: 3,
      updated_by: member.id,
      updated_at: T1,
    });
    expect(await readPage(page.id)).toMatchObject({ spaceId: other.id, folderId: null, version: 3 });

    // The revisions move with the page and are read through it.
    const revisions = await getJson<PageRevisionList>(`/api/v1/pages/${page.id}/revisions`, memberCookies);
    expect(revisions.revisions.map((r) => r.version)).toEqual([1]);
    const revision = await getJson<{ title: string; body: string }>(
      `/api/v1/pages/${page.id}/revisions/1`,
      memberCookies,
    );
    expect(revision).toMatchObject({ title: "Old", body: "old" });
  });

  it("moves a page into a folder of another space", async () => {
    const target = await insertFolder({ spaceId: other.id });
    const page = await insertPage({ spaceId: everyone.id });
    const res = await postPageMove(page.id, memberCookies, { version: 1, space_id: other.id, folder_id: target.id });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Page).folder_id).toBe(target.id);
    expect(await readPage(page.id)).toMatchObject({ spaceId: other.id, folderId: target.id, version: 2 });
  });

  it("moves a page inside its space, like PATCH with folder_id", async () => {
    const from = await insertFolder({ spaceId: everyone.id });
    const to = await insertFolder({ spaceId: everyone.id });
    const page = await insertPage({ spaceId: everyone.id, folderId: from.id });
    const res = await postPageMove(page.id, memberCookies, { version: 1, space_id: everyone.id, folder_id: to.id });
    expect(res.status).toBe(200);
    expect(await readPage(page.id)).toMatchObject({ spaceId: everyone.id, folderId: to.id, version: 2 });
  });

  it("returns 400 folder_not_found for a folder that is not in the destination space", async () => {
    const inSource = await insertFolder({ spaceId: everyone.id });
    const page = await insertPage({ spaceId: everyone.id });
    for (const folderId of [inSource.id, "missing"]) {
      const res = await postPageMove(page.id, memberCookies, { version: 1, space_id: other.id, folder_id: folderId });
      expect(res.status).toBe(400);
      expect(await errorBody(res)).toEqual({ code: "folder_not_found", message: "移動先のフォルダが見つかりません" });
    }
    expect(await readPage(page.id)).toMatchObject({ spaceId: everyone.id, folderId: null, version: 1 });
  });

  it("returns 400 space_not_found for a destination the user cannot access", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    // A members space that the user is not a member of.
    const team = await insertSpace("members", "Team");
    for (const spaceId of [adminOnly.id, team.id, (await personalSpaceOf(admin)).id, "missing"]) {
      const res = await postPageMove(page.id, memberCookies, { version: 1, space_id: spaceId });
      expect(res.status).toBe(400);
      expect(await errorBody(res)).toEqual({ code: "space_not_found", message: "移動先のスペースが見つかりません" });
    }
    expect(await readPage(page.id)).toMatchObject({ spaceId: everyone.id, version: 1 });
  });

  it("returns 404 for a page the user cannot access, missing or in the trash", async () => {
    const inAdmin = await insertPage({ spaceId: adminOnly.id });
    const inTrash = await insertPage({ spaceId: everyone.id, deletedAt: T0, deletedBy: member.id });
    for (const id of [inAdmin.id, inTrash.id, "missing"]) {
      const res = await postPageMove(id, memberCookies, { version: 1, space_id: other.id });
      expect(res.status).toBe(404);
      expect((await errorBody(res)).code).toBe("not_found");
    }
    expect(await readPage(inAdmin.id)).toMatchObject({ spaceId: adminOnly.id, version: 1 });
    expect(await readPage(inTrash.id)).toMatchObject({ spaceId: everyone.id, version: 1 });
  });

  it("returns 409 version_conflict for an old version", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const res = await postPageMove(page.id, memberCookies, { version: 2, space_id: other.id });
    expect(res.status).toBe(409);
    expect((await errorBody(res)).code).toBe("version_conflict");
    expect(await readPage(page.id)).toMatchObject({ spaceId: everyone.id, version: 1 });
  });

  it.each([
    ["not an object", [], "invalid_body"],
    ["no version", { space_id: "s" }, "invalid_version"],
    ["an invalid version before an invalid space_id", { version: 0, space_id: "" }, "invalid_version"],
    ["no space_id", { version: 1 }, "invalid_space_id"],
    ["an empty space_id", { version: 1, space_id: "" }, "invalid_space_id"],
    ["a space_id that is not a string", { version: 1, space_id: 1 }, "invalid_space_id"],
    ["an invalid space_id before an invalid folder_id", { version: 1, space_id: null, folder_id: 1 }, "invalid_space_id"],
    ["an empty folder_id", { version: 1, space_id: "s", folder_id: "" }, "invalid_folder_id"],
    ["a folder_id that is not a string", { version: 1, space_id: "s", folder_id: 1 }, "invalid_folder_id"],
  ])("returns 400 for %s", async (_, json, code) => {
    const page = await insertPage({ spaceId: everyone.id });
    const res = await postPageMove(page.id, memberCookies, json);
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe(code);
  });

  it("requires login", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const res = await send(`/api/v1/pages/${page.id}/move`, { json: { version: 1, space_id: other.id } });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/v1/folders/:id/move", () => {
  // root (in parent0) > child > grandchild, with a page in each and a page in the trash in grandchild.
  async function tree() {
    const parent0 = await insertFolder({ spaceId: everyone.id, name: "Parent", at: T0 });
    const root = await insertFolder({ spaceId: everyone.id, parentId: parent0.id, name: "Root", at: T0 });
    const child = await insertFolder({ spaceId: everyone.id, parentId: root.id, name: "Child", at: T0 });
    const grandchild = await insertFolder({ spaceId: everyone.id, parentId: child.id, name: "Grandchild", at: T0 });
    const inRoot = await insertPage({ spaceId: everyone.id, folderId: root.id, title: "In root", at: T0 });
    const inChild = await insertPage({ spaceId: everyone.id, folderId: child.id, title: "In child", at: T0 });
    const inGrandchild = await insertPage({
      spaceId: everyone.id,
      folderId: grandchild.id,
      title: "In grandchild",
      at: T0,
    });
    const trashed = await insertPage({
      spaceId: everyone.id,
      folderId: grandchild.id,
      title: "Trashed",
      at: T0,
      deletedAt: T0,
      deletedBy: member.id,
    });
    // Not in the tree.
    const outside = await insertPage({ spaceId: everyone.id, folderId: parent0.id, title: "Outside", at: T0 });
    const sibling = await insertFolder({ spaceId: everyone.id, parentId: parent0.id, name: "Sibling", at: T0 });
    return { parent0, root, child, grandchild, inRoot, inChild, inGrandchild, trashed, outside, sibling };
  }

  async function expectUnchanged(t: Awaited<ReturnType<typeof tree>>) {
    expect(await readFolder(t.root.id)).toEqual(t.root);
    for (const folder of [t.parent0, t.child, t.grandchild, t.sibling]) {
      expect(await readFolder(folder.id)).toEqual(folder);
    }
    for (const page of [t.inRoot, t.inChild, t.inGrandchild, t.trashed, t.outside]) {
      expect(await readPage(page.id)).toEqual(page);
    }
  }

  it("moves a folder with its folders and pages, including pages in the trash, to another space", async () => {
    const t = await tree();
    const target = await insertFolder({ spaceId: other.id, name: "Target" });
    setNow(T1);
    const res = await postFolderMove(t.root.id, memberCookies, { space_id: other.id, parent_id: target.id });
    expect(res.status).toBe(200);
    expect((await res.json()) as Folder).toEqual({
      id: t.root.id,
      space_id: other.id,
      parent_id: target.id,
      name: "Root",
      created_by: null,
      updated_by: member.id,
      created_at: T0,
      updated_at: T1,
    });
    // The folders inside keep their parents and updated_at.
    expect(await readFolder(t.child.id)).toEqual({ ...t.child, spaceId: other.id });
    expect(await readFolder(t.grandchild.id)).toEqual({ ...t.grandchild, spaceId: other.id });
    // The pages keep their folder, version and updated_at, and the page in the trash stays there.
    for (const page of [t.inRoot, t.inChild, t.inGrandchild, t.trashed]) {
      expect(await readPage(page.id)).toEqual({ ...page, spaceId: other.id });
    }
    // Nothing outside the tree moves.
    expect(await readFolder(t.parent0.id)).toEqual(t.parent0);
    expect(await readFolder(t.sibling.id)).toEqual(t.sibling);
    expect(await readPage(t.outside.id)).toEqual(t.outside);
  });

  it("shows the moved contents in the destination space and not in the source", async () => {
    const t = await tree();
    const res = await postFolderMove(t.root.id, memberCookies, { space_id: other.id });
    expect(res.status).toBe(200);

    const otherPages = await getJson<PageList>(`/api/v1/spaces/${other.id}/pages`, memberCookies);
    expect(otherPages.pages.map((p) => p.id).sort()).toEqual([t.inRoot.id, t.inChild.id, t.inGrandchild.id].sort());
    const everyonePages = await getJson<PageList>(`/api/v1/spaces/${everyone.id}/pages`, memberCookies);
    expect(everyonePages.pages.map((p) => p.id)).toEqual([t.outside.id]);

    const otherFolders = await getJson<FolderList>(`/api/v1/spaces/${other.id}/folders`, memberCookies);
    expect(otherFolders.folders.map((f) => f.id).sort()).toEqual([t.root.id, t.child.id, t.grandchild.id].sort());
    const everyoneFolders = await getJson<FolderList>(`/api/v1/spaces/${everyone.id}/folders`, memberCookies);
    expect(everyoneFolders.folders.map((f) => f.id).sort()).toEqual([t.parent0.id, t.sibling.id].sort());

    const otherTrash = await getJson<TrashList>(`/api/v1/spaces/${other.id}/trash`, memberCookies);
    expect(otherTrash.pages.map((p) => p.id)).toEqual([t.trashed.id]);
    const everyoneTrash = await getJson<TrashList>(`/api/v1/spaces/${everyone.id}/trash`, memberCookies);
    expect(everyoneTrash.pages).toEqual([]);

    const search = await getJson<SearchResult>(`/api/v1/search?q=${encodeURIComponent("In child")}`, memberCookies);
    expect(search.hits.map((h) => [h.id, h.space_id])).toEqual([[t.inChild.id, other.id]]);
  });

  it("moves a folder to the top level of another space when parent_id is missing or null", async () => {
    const t = await tree();
    const res = await postFolderMove(t.root.id, memberCookies, { space_id: other.id, parent_id: null });
    expect(res.status).toBe(200);
    expect(await readFolder(t.root.id)).toMatchObject({ spaceId: other.id, parentId: null });
    const child = await postFolderMove(t.child.id, memberCookies, { space_id: everyone.id });
    expect(child.status).toBe(200);
    expect(await readFolder(t.child.id)).toMatchObject({ spaceId: everyone.id, parentId: null });
    // The grandchild and its pages follow the child back.
    expect(await readFolder(t.grandchild.id)).toMatchObject({ spaceId: everyone.id, parentId: t.child.id });
    expect(await readPage(t.trashed.id)).toMatchObject({ spaceId: everyone.id, folderId: t.grandchild.id });
  });

  it("moves a folder inside its space, like PATCH with parent_id", async () => {
    const t = await tree();
    const res = await postFolderMove(t.root.id, memberCookies, { space_id: everyone.id, parent_id: t.sibling.id });
    expect(res.status).toBe(200);
    expect(await readFolder(t.root.id)).toMatchObject({ spaceId: everyone.id, parentId: t.sibling.id });
    expect(await readPage(t.inChild.id)).toEqual(t.inChild);
  });

  it("allows deleting the source space once its contents have moved", async () => {
    const source = await insertSpace("everyone", "Source");
    const folder = await insertFolder({ spaceId: source.id });
    await insertPage({ spaceId: source.id, folderId: folder.id });
    await insertPage({ spaceId: source.id, folderId: folder.id, deletedAt: T0, deletedBy: member.id });
    expect((await postFolderMove(folder.id, memberCookies, { space_id: everyone.id })).status).toBe(200);
    const res = await send(`/api/v1/spaces/${source.id}`, { method: "DELETE", cookies: adminCookies });
    expect(res.status).toBe(204);
  });

  it("returns 400 parent_not_found for a parent that is not in the destination space", async () => {
    const t = await tree();
    const elsewhere = await insertFolder({ spaceId: adminOnly.id });
    // A folder of the source space, a folder of a third space, and a missing one, to another space.
    for (const parentId of [t.sibling.id, elsewhere.id, "missing"]) {
      const res = await postFolderMove(t.root.id, memberCookies, { space_id: other.id, parent_id: parentId });
      expect(res.status).toBe(400);
      expect(await errorBody(res)).toEqual({ code: "parent_not_found", message: "移動先のフォルダが見つかりません" });
    }
    // A folder of another space, inside the same space.
    const inOther = await insertFolder({ spaceId: other.id });
    const same = await postFolderMove(t.root.id, memberCookies, { space_id: everyone.id, parent_id: inOther.id });
    expect(same.status).toBe(400);
    expect((await errorBody(same)).code).toBe("parent_not_found");
    await expectUnchanged(t);
  });

  it("returns 409 folder_cycle for the folder itself or a folder inside it as the parent", async () => {
    const t = await tree();
    for (const parentId of [t.root.id, t.child.id, t.grandchild.id]) {
      const res = await postFolderMove(t.root.id, memberCookies, { space_id: everyone.id, parent_id: parentId });
      expect(res.status).toBe(409);
      expect(await errorBody(res)).toEqual({
        code: "folder_cycle",
        message: "フォルダを自分自身やその中のフォルダへは移せません",
      });
    }
    await expectUnchanged(t);
  });

  it("returns 400 space_not_found for a destination the user cannot access", async () => {
    const t = await tree();
    // A members space that the user is not a member of.
    const team = await insertSpace("members", "Team");
    for (const spaceId of [adminOnly.id, team.id, (await personalSpaceOf(admin)).id, "missing"]) {
      const res = await postFolderMove(t.root.id, memberCookies, { space_id: spaceId });
      expect(res.status).toBe(400);
      expect(await errorBody(res)).toEqual({ code: "space_not_found", message: "移動先のスペースが見つかりません" });
    }
    await expectUnchanged(t);
  });

  it("returns 404 for a folder the user cannot access or that is missing", async () => {
    const inAdmin = await insertFolder({ spaceId: adminOnly.id });
    const page = await insertPage({ spaceId: adminOnly.id, folderId: inAdmin.id });
    for (const id of [inAdmin.id, "missing"]) {
      const res = await postFolderMove(id, memberCookies, { space_id: everyone.id });
      expect(res.status).toBe(404);
      expect((await errorBody(res)).code).toBe("not_found");
    }
    expect(await readFolder(inAdmin.id)).toEqual(inAdmin);
    expect(await readPage(page.id)).toEqual(page);
  });

  it.each([
    ["not an object", "x", "invalid_body"],
    ["no space_id", {}, "invalid_space_id"],
    ["an empty space_id", { space_id: "" }, "invalid_space_id"],
    ["an invalid space_id before an invalid parent_id", { space_id: 1, parent_id: 1 }, "invalid_space_id"],
    ["an empty parent_id", { space_id: "s", parent_id: "" }, "invalid_parent_id"],
    ["a parent_id that is not a string", { space_id: "s", parent_id: false }, "invalid_parent_id"],
  ])("returns 400 for %s", async (_, json, code) => {
    const folder = await insertFolder({ spaceId: everyone.id });
    const res = await postFolderMove(folder.id, memberCookies, json);
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe(code);
  });
});

describe("changes between the checks and the write", () => {
  it("does not move a page that moved to another space after the check", async () => {
    const page = await insertPage({ spaceId: everyone.id });
    const personal = await personalSpaceOf(member);
    // At the check the page is in an everyone space, so the move to another everyone space does not widen
    // the visibility. Then the page moves to the personal space: the move would now widen it.
    const changing = dbChangingBefore(/^update "pages"/i, () =>
      db.update(pages).set({ spaceId: personal.id }).where(eq(pages.id, page.id)).run(),
    );
    const result = await movePage(changing, member, page.id, { version: 1, spaceId: other.id, folderId: null }, MCP_WITHOUT_ACK);
    expect(result).toEqual({ ok: false, error: "not_found" });
    expect(await readPage(page.id)).toMatchObject({ spaceId: personal.id, version: 1 });
  });

  it("does not move a folder that moved to another space after the check", async () => {
    const folder = await insertFolder({ spaceId: everyone.id });
    const child = await insertFolder({ spaceId: everyone.id, parentId: folder.id });
    const page = await insertPage({ spaceId: everyone.id, folderId: child.id });
    const personal = await personalSpaceOf(member);
    const changing = dbChangingBefore(/^update "pages"/i, () =>
      env.DB.batch([
        env.DB.prepare("UPDATE pages SET space_id = ? WHERE id = ?").bind(personal.id, page.id),
        env.DB.prepare("UPDATE folders SET space_id = ? WHERE id IN (?, ?)").bind(personal.id, folder.id, child.id),
      ]),
    );
    const result = await moveFolder(changing, member, folder.id, { spaceId: other.id, parentId: null }, MCP_WITHOUT_ACK);
    expect(result).toEqual({ ok: false, error: "not_found" });
    expect(await readFolder(folder.id)).toMatchObject({ spaceId: personal.id });
    expect(await readFolder(child.id)).toMatchObject({ spaceId: personal.id });
    expect(await readPage(page.id)).toMatchObject({ spaceId: personal.id });
  });

  it("returns space_not_found when the destination space is deleted before the page moves", async () => {
    const doomed = await insertSpace("everyone", "Doomed");
    const page = await insertPage({ spaceId: everyone.id });
    const changing = dbChangingBefore(/^update "pages"/i, () =>
      db.delete(spaces).where(eq(spaces.id, doomed.id)).run(),
    );
    const result = await movePage(changing, member, page.id, { version: 1, spaceId: doomed.id, folderId: null }, REST);
    expect(result).toEqual({ ok: false, error: "space_not_found" });
    expect(await readPage(page.id)).toMatchObject({ spaceId: everyone.id, version: 1 });
  });

  it("returns space_not_found when the destination space is deleted before the folder moves", async () => {
    const doomed = await insertSpace("everyone", "Doomed");
    const folder = await insertFolder({ spaceId: everyone.id });
    const page = await insertPage({ spaceId: everyone.id, folderId: folder.id });
    const changing = dbChangingBefore(/^update "pages"/i, () =>
      db.delete(spaces).where(eq(spaces.id, doomed.id)).run(),
    );
    const result = await moveFolder(changing, member, folder.id, { spaceId: doomed.id, parentId: null }, REST);
    expect(result).toEqual({ ok: false, error: "space_not_found" });
    expect(await readFolder(folder.id)).toEqual(folder);
    expect(await readPage(page.id)).toEqual(page);
  });

  it("moves nothing when the parent moves to another space before the folder moves", async () => {
    const folder = await insertFolder({ spaceId: everyone.id });
    const page = await insertPage({ spaceId: everyone.id, folderId: folder.id });
    const target = await insertFolder({ spaceId: other.id });
    const changing = dbChangingBefore(/^update "pages"/i, () =>
      db.update(folders).set({ spaceId: adminOnly.id }).where(eq(folders.id, target.id)).run(),
    );
    const result = await moveFolder(changing, member, folder.id, { spaceId: other.id, parentId: target.id }, REST);
    expect(result).toEqual({ ok: false, error: "parent_not_found" });
    expect(await readFolder(folder.id)).toEqual(folder);
    expect(await readPage(page.id)).toEqual(page);
  });

  it("creates no folder when the parent moves to another space before the insert", async () => {
    const parent = await insertFolder({ spaceId: everyone.id });
    const changing = dbChangingBefore(/^insert into "folders"/i, () =>
      db.update(folders).set({ spaceId: other.id }).where(eq(folders.id, parent.id)).run(),
    );
    const result = await createFolder(changing, member, everyone.id, { name: "Child", parentId: parent.id });
    expect(result).toEqual({ ok: false, error: "parent_not_found" });
    expect(await countFolders()).toBe(1);
  });

  it("creates no page when the folder moves to another space before the insert", async () => {
    const folder = await insertFolder({ spaceId: everyone.id });
    const changing = dbChangingBefore(/^insert into "pages"/i, () =>
      db.update(folders).set({ spaceId: other.id }).where(eq(folders.id, folder.id)).run(),
    );
    const result = await createPage(changing, member, everyone.id, { title: "T", body: "", folderId: folder.id });
    expect(result).toEqual({ ok: false, error: "folder_not_found" });
    expect(await countPages()).toBe(0);
  });
});

describe("creating in a folder of another space", () => {
  it("rejects a folder whose parent is in another space", async () => {
    const elsewhere = await insertFolder({ spaceId: other.id });
    const res = await send(`/api/v1/spaces/${everyone.id}/folders`, {
      cookies: memberCookies,
      json: { name: "Child", parent_id: elsewhere.id },
    });
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe("parent_not_found");
    expect(await countFolders()).toBe(1);
  });

  it("rejects a page in a folder of another space", async () => {
    const elsewhere = await insertFolder({ spaceId: other.id });
    const res = await send(`/api/v1/spaces/${everyone.id}/pages`, {
      cookies: memberCookies,
      json: { title: "T", body: "", folder_id: elsewhere.id },
    });
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe("folder_not_found");
    expect(await countPages()).toBe(0);
  });

  it("creates a folder and a page with all their columns", async () => {
    const parent = await insertFolder({ spaceId: everyone.id });
    const folder = await createFolder(appDb, member, everyone.id, { name: "Child", parentId: parent.id });
    expect(folder.ok && (await readFolder(folder.folder.id))).toEqual({
      id: expect.any(String),
      spaceId: everyone.id,
      parentId: parent.id,
      name: "Child",
      createdBy: member.id,
      updatedBy: member.id,
      createdAt: T0,
      updatedAt: T0,
    });
    const page = await createPage(appDb, member, everyone.id, { title: "T", body: "B", folderId: null });
    expect(page.ok && (await readPage(page.page.id))).toEqual({
      id: expect.any(String),
      spaceId: everyone.id,
      folderId: null,
      title: "T",
      body: "B",
      version: 1,
      createdBy: member.id,
      updatedBy: member.id,
      createdAt: T0,
      updatedAt: T0,
      deletedAt: null,
      deletedBy: null,
    });
  });
});
