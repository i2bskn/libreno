import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Attachment, BacklinkList, SearchResult, Space, SpaceList, TopPage } from "../src/api/types";
import { createAttachment, deleteAttachment } from "../src/attachments/service";
import { clock } from "../src/clock";
import { attachments, folders, pages, spaces, type FolderRow, type PageRow, type SpaceRow, type UserRow } from "../src/db/schema";
import { createFolder, deleteFolder, moveFolder, updateFolder } from "../src/folders/service";
import { restorePageRevision } from "../src/pages/revisions";
import { createPage, movePage, updatePage } from "../src/pages/service";
import { setTopPage } from "../src/pages/top-page";
import { purgeTrashedPage, restoreTrashedPage, trashPage } from "../src/pages/trash";
import {
  createUser,
  db,
  dbChangingBefore,
  insertFolder,
  insertPage,
  login,
  resetAttachments,
  resetDb,
  send,
  type SessionCookies,
} from "./helpers";

const T0 = Date.UTC(2026, 9, 1);
const archivedMessage = "アーカイブされたスペースは編集できません。アーカイブを解除してから操作してください";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const noAck = { requireVisibilityAck: false, acknowledged: false };

function setNow(now: number) {
  vi.spyOn(clock, "now").mockReturnValue(now);
}

async function insertSpace(kind: "everyone" | "admin", name: string, createdAt = T0): Promise<SpaceRow> {
  const [space] = await db
    .insert(spaces)
    .values({ id: crypto.randomUUID(), kind, name, createdAt, updatedAt: createdAt })
    .returning();
  if (!space) throw new Error("failed to create space");
  return space;
}

async function personalSpaceOf(user: UserRow): Promise<SpaceRow> {
  const space = await db.query.spaces.findFirst({ where: eq(spaces.ownerUserId, user.id) });
  if (!space) throw new Error("personal space not found");
  return space;
}

// Archives the space directly, bypassing the API.
function archive(spaceId: string, at = T0) {
  return db.update(spaces).set({ archivedAt: at }).where(eq(spaces.id, spaceId)).run();
}

function unarchive(spaceId: string) {
  return db.update(spaces).set({ archivedAt: null }).where(eq(spaces.id, spaceId)).run();
}

async function errorOf(res: Response): Promise<{ code: string; message: string }> {
  return ((await res.json()) as { error: { code: string; message: string } }).error;
}

async function expectArchived(res: Response) {
  expect(res.status).toBe(409);
  expect(await errorOf(res)).toEqual({ code: "space_archived", message: archivedMessage });
}

function readPage(id: string): Promise<PageRow | undefined> {
  return db.query.pages.findFirst({ where: eq(pages.id, id) });
}

function readFolder(id: string): Promise<FolderRow | undefined> {
  return db.query.folders.findFirst({ where: eq(folders.id, id) });
}

async function countAttachmentRows(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM attachments").first<{ count: number }>();
  return row?.count ?? 0;
}

async function objectCount(): Promise<number> {
  return (await env.ATTACHMENTS.list()).objects.length;
}

function upload(pageId: string, cookies: SessionCookies, body: BodyInit): Promise<Response> {
  return send(`/api/v1/pages/${pageId}/attachments?filename=file`, { cookies, body });
}

let admin: UserRow;
let member: UserRow;
let adminCookies: SessionCookies;
let memberCookies: SessionCookies;
let space: SpaceRow;
let other: SpaceRow;
let adminSpace: SpaceRow;

beforeEach(async () => {
  await resetDb();
  await resetAttachments();
  setNow(T0);
  admin = await createUser({ email: "admin@example.com", role: "admin", createdAt: T0 });
  member = await createUser({ email: "member@example.com", role: "member", createdAt: T0 });
  adminCookies = await login(admin.email);
  memberCookies = await login(member.email);
  space = await insertSpace("everyone", "Archive me", T0);
  other = await insertSpace("everyone", "Other", T0 + 1);
  adminSpace = await insertSpace("admin", "Admins", T0 + 2);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/v1/spaces/:id/archive and /unarchive", () => {
  it("archives and unarchives a space, and is idempotent", async () => {
    setNow(T0 + 1000);
    const res = await send(`/api/v1/spaces/${space.id}/archive`, { method: "POST", cookies: adminCookies });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Space).archived_at).toBe(T0 + 1000);
    expect(await db.query.spaces.findFirst({ where: eq(spaces.id, space.id) })).toMatchObject({
      archivedAt: T0 + 1000,
      updatedAt: T0 + 1000,
    });

    setNow(T0 + 2000);
    const again = await send(`/api/v1/spaces/${space.id}/archive`, { method: "POST", cookies: adminCookies });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ archived_at: T0 + 1000, updated_at: T0 + 1000 });

    const unarchived = await send(`/api/v1/spaces/${space.id}/unarchive`, { method: "POST", cookies: adminCookies });
    expect(unarchived.status).toBe(200);
    expect(await unarchived.json()).toMatchObject({ archived_at: null, updated_at: T0 + 2000 });

    setNow(T0 + 3000);
    const unarchivedAgain = await send(`/api/v1/spaces/${space.id}/unarchive`, {
      method: "POST",
      cookies: adminCookies,
    });
    expect(unarchivedAgain.status).toBe(200);
    expect(await unarchivedAgain.json()).toMatchObject({ archived_at: null, updated_at: T0 + 2000 });
  });

  it("is forbidden for a member", async () => {
    for (const action of ["archive", "unarchive"]) {
      const res = await send(`/api/v1/spaces/${space.id}/${action}`, { method: "POST", cookies: memberCookies });
      expect(res.status).toBe(403);
    }
    expect((await db.query.spaces.findFirst({ where: eq(spaces.id, space.id) }))?.archivedAt).toBeNull();
  });

  it("is forbidden for the admin's own personal space", async () => {
    const personal = await personalSpaceOf(admin);
    for (const action of ["archive", "unarchive"]) {
      const res = await send(`/api/v1/spaces/${personal.id}/${action}`, { method: "POST", cookies: adminCookies });
      expect(res.status).toBe(403);
      expect(await errorOf(res)).toEqual({ code: "forbidden", message: "個人スペースはアーカイブできません" });
    }
  });

  it("reports a space the admin cannot access, or a missing one, as not found", async () => {
    for (const id of [(await personalSpaceOf(member)).id, "missing"]) {
      const res = await send(`/api/v1/spaces/${id}/archive`, { method: "POST", cookies: adminCookies });
      expect(res.status).toBe(404);
      expect((await errorOf(res)).code).toBe("not_found");
    }
  });
});

describe("GET /api/v1/spaces", () => {
  it("lists the spaces that are not archived by default, and only the archived ones with archived=true", async () => {
    await archive(space.id);
    await archive(adminSpace.id);
    const list = async (url: string, cookies: SessionCookies) =>
      ((await (await send(url, { cookies })).json()) as SpaceList).spaces.map((s) => s.name);

    expect(await list("/api/v1/spaces", adminCookies)).toEqual(["Other", null]);
    expect(await list("/api/v1/spaces?archived=false", adminCookies)).toEqual(["Other", null]);
    expect(await list("/api/v1/spaces?archived=1", adminCookies)).toEqual(["Other", null]);
    expect(await list("/api/v1/spaces?archived=true", adminCookies)).toEqual(["Archive me", "Admins"]);
    // A member does not see the archived admin space either.
    expect(await list("/api/v1/spaces?archived=true", memberCookies)).toEqual(["Archive me"]);
  });

  it("returns archived_at on the archived spaces", async () => {
    await archive(space.id, T0 + 5);
    const res = await send("/api/v1/spaces?archived=true", { cookies: memberCookies });
    expect(((await res.json()) as SpaceList).spaces).toEqual([
      expect.objectContaining({ id: space.id, archived_at: T0 + 5 }),
    ]);
  });
});

describe("writes to an archived space", () => {
  let page: PageRow;
  let folder: FolderRow;
  let trashed: PageRow;

  beforeEach(async () => {
    folder = await insertFolder({ spaceId: space.id, name: "Docs", at: T0 });
    page = await insertPage({ spaceId: space.id, title: "Page", body: "body", at: T0 });
    trashed = await insertPage({ spaceId: space.id, title: "Trashed", at: T0, deletedAt: T0, deletedBy: admin.id });
  });

  it("rejects creating a page and a folder", async () => {
    await archive(space.id);
    await expectArchived(
      await send(`/api/v1/spaces/${space.id}/pages`, { cookies: memberCookies, json: { title: "New", body: "" } }),
    );
    // Before the check of the folder.
    await expectArchived(
      await send(`/api/v1/spaces/${space.id}/pages`, {
        cookies: memberCookies,
        json: { title: "New", body: "", folder_id: "missing" },
      }),
    );
    await expectArchived(
      await send(`/api/v1/spaces/${space.id}/folders`, { cookies: memberCookies, json: { name: "New" } }),
    );
    expect(await db.select().from(pages).where(eq(pages.spaceId, space.id)).all()).toHaveLength(2);
    expect(await db.select().from(folders).where(eq(folders.spaceId, space.id)).all()).toHaveLength(1);
  });

  it("rejects updating, trashing and restoring a revision of a page", async () => {
    // A revision to restore, made before the space is archived.
    const updated = await send(`/api/v1/pages/${page.id}`, {
      method: "PATCH",
      cookies: memberCookies,
      json: { version: 1, body: "second" },
    });
    expect(updated.status).toBe(200);
    await archive(space.id);

    await expectArchived(
      await send(`/api/v1/pages/${page.id}`, { method: "PATCH", cookies: memberCookies, json: { version: 2, title: "X" } }),
    );
    // Before the version conflict.
    await expectArchived(
      await send(`/api/v1/pages/${page.id}`, { method: "PATCH", cookies: memberCookies, json: { version: 9, title: "X" } }),
    );
    await expectArchived(
      await send(`/api/v1/pages/${page.id}/revisions/1/restore`, { cookies: memberCookies, json: { version: 2 } }),
    );
    // Before the check of the revision.
    await expectArchived(
      await send(`/api/v1/pages/${page.id}/revisions/99/restore`, { cookies: memberCookies, json: { version: 2 } }),
    );
    await expectArchived(await send(`/api/v1/pages/${page.id}`, { method: "DELETE", cookies: memberCookies }));

    expect(await readPage(page.id)).toMatchObject({ version: 2, title: "Page", body: "second", deletedAt: null });
  });

  it("rejects restoring and purging a page in the trash", async () => {
    await archive(space.id);
    await expectArchived(await send(`/api/v1/pages/${trashed.id}/restore`, { cookies: memberCookies, method: "POST" }));
    // Before not_in_trash.
    await expectArchived(await send(`/api/v1/pages/${page.id}/restore`, { cookies: memberCookies, method: "POST" }));
    await expectArchived(
      await send(`/api/v1/pages/${trashed.id}/permanent`, { method: "DELETE", cookies: adminCookies }),
    );
    expect((await readPage(trashed.id))?.deletedAt).toBe(T0);
  });

  it("rejects moving a page out of and into an archived space", async () => {
    const outside = await insertPage({ spaceId: other.id, title: "Outside", at: T0 });
    await archive(space.id);
    await expectArchived(
      await send(`/api/v1/pages/${page.id}/move`, {
        cookies: memberCookies,
        json: { version: 1, space_id: other.id, folder_id: null },
      }),
    );
    await expectArchived(
      await send(`/api/v1/pages/${outside.id}/move`, {
        cookies: memberCookies,
        json: { version: 1, space_id: space.id, folder_id: null },
      }),
    );
    expect(await readPage(page.id)).toMatchObject({ spaceId: space.id, version: 1 });
    expect(await readPage(outside.id)).toMatchObject({ spaceId: other.id, version: 1 });
  });

  it("rejects renaming, deleting and moving a folder", async () => {
    const outside = await insertFolder({ spaceId: other.id, name: "Outside", at: T0 });
    await archive(space.id);
    await expectArchived(
      await send(`/api/v1/folders/${folder.id}`, { method: "PATCH", cookies: memberCookies, json: { name: "X" } }),
    );
    await expectArchived(await send(`/api/v1/folders/${folder.id}`, { method: "DELETE", cookies: memberCookies }));
    await expectArchived(
      await send(`/api/v1/folders/${folder.id}/move`, { cookies: memberCookies, json: { space_id: other.id } }),
    );
    await expectArchived(
      await send(`/api/v1/folders/${outside.id}/move`, { cookies: memberCookies, json: { space_id: space.id } }),
    );
    expect(await readFolder(folder.id)).toMatchObject({ name: "Docs", spaceId: space.id });
    expect(await readFolder(outside.id)).toMatchObject({ spaceId: other.id });
  });

  it("rejects adding and deleting attachments, without writing to R2", async () => {
    const res = await upload(page.id, memberCookies, PNG);
    expect(res.status).toBe(201);
    const attachment = (await res.json()) as Attachment;
    await archive(space.id);

    await expectArchived(await upload(page.id, memberCookies, PNG));
    // The checks of the contents come first.
    expect((await errorOf(await upload(page.id, memberCookies, new Uint8Array([1, 2, 3])))).code).toBe(
      "unsupported_type",
    );
    await expectArchived(await send(`/api/v1/attachments/${attachment.id}`, { method: "DELETE", cookies: memberCookies }));
    expect(await countAttachmentRows()).toBe(1);
    expect(await objectCount()).toBe(1);
  });

  it("rejects setting a page of an archived space as the top page", async () => {
    await archive(space.id);
    await expectArchived(
      await send("/api/v1/top-page", { method: "PUT", cookies: adminCookies, json: { page_id: page.id } }),
    );
    expect(await db.query.siteSettings.findFirst()).toBeUndefined();
  });

  it("reports a page of a space the user cannot access as missing, not as archived", async () => {
    const adminPage = await insertPage({ spaceId: adminSpace.id, title: "Secret", at: T0 });
    await archive(adminSpace.id);
    const res = await send(`/api/v1/pages/${adminPage.id}`, {
      method: "PATCH",
      cookies: memberCookies,
      json: { version: 1, title: "X" },
    });
    expect(res.status).toBe(404);
  });

  it("still allows renaming, reordering and deleting the space itself", async () => {
    await archive(space.id);
    const renamed = await send(`/api/v1/spaces/${space.id}`, {
      method: "PATCH",
      cookies: adminCookies,
      json: { name: "Renamed", sort_order: 3 },
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ name: "Renamed", sort_order: 3 });
  });

  it("accepts writes again once the space is unarchived", async () => {
    await archive(space.id);
    await unarchive(space.id);
    const res = await send(`/api/v1/pages/${page.id}`, {
      method: "PATCH",
      cookies: memberCookies,
      json: { version: 1, title: "Again" },
    });
    expect(res.status).toBe(200);
    expect((await readPage(page.id))?.title).toBe("Again");
  });

  it("still serves the reads", async () => {
    await archive(space.id);
    for (const url of [
      `/api/v1/spaces/${space.id}`,
      `/api/v1/spaces/${space.id}/pages`,
      `/api/v1/spaces/${space.id}/folders`,
      `/api/v1/spaces/${space.id}/trash`,
      `/api/v1/pages/${page.id}`,
      `/api/v1/pages/${page.id}/revisions`,
      `/api/v1/pages/${page.id}/attachments`,
      `/api/v1/folders/${folder.id}`,
    ]) {
      expect((await send(url, { cookies: memberCookies })).status, url).toBe(200);
    }
  });

  describe("when the space is archived after the checks", () => {
    // Archives the space right before the write statement, as if another request did it in between.
    function archivingBefore(pattern: RegExp) {
      return dbChangingBefore(pattern, () => archive(space.id));
    }

    it("creates no page or folder", async () => {
      expect(
        await createPage(archivingBefore(/^insert into "pages"/i), member, space.id, {
          title: "T",
          body: "",
          folderId: null,
        }),
      ).toEqual({ ok: false, error: "space_archived" });
      await unarchive(space.id);
      expect(
        await createFolder(archivingBefore(/^insert into "folders"/i), member, space.id, { name: "F", parentId: null }),
      ).toEqual({ ok: false, error: "space_archived" });
      expect(await db.select().from(pages).where(eq(pages.spaceId, space.id)).all()).toHaveLength(2);
      expect(await db.select().from(folders).where(eq(folders.spaceId, space.id)).all()).toHaveLength(1);
    });

    it("does not update, move, trash or restore a revision of a page", async () => {
      expect(await updatePage(archivingBefore(/^update "pages"/i), member, page.id, { version: 1, title: "X" })).toEqual(
        { ok: false, error: "space_archived" },
      );
      await unarchive(space.id);
      expect(
        await movePage(archivingBefore(/^update "pages"/i), member, page.id, {
          version: 1,
          spaceId: other.id,
          folderId: null,
        }, noAck),
      ).toEqual({ ok: false, error: "space_archived" });
      await unarchive(space.id);
      expect(await trashPage(archivingBefore(/^update "pages"/i), member, page.id)).toEqual({
        ok: false,
        error: "space_archived",
      });
      await unarchive(space.id);
      // A revision to restore.
      expect((await updatePage(db, member, page.id, { version: 1, body: "second" })).ok).toBe(true);
      expect(await restorePageRevision(archivingBefore(/^update "pages"/i), member, page.id, 1, 2)).toEqual({
        ok: false,
        error: "space_archived",
      });
      expect(await readPage(page.id)).toMatchObject({ version: 2, title: "Page", body: "second", deletedAt: null });
    });

    it("does not restore or purge a page in the trash", async () => {
      expect(await restoreTrashedPage(archivingBefore(/^update "pages"/i), member, trashed.id)).toEqual({
        ok: false,
        error: "space_archived",
      });
      await unarchive(space.id);
      expect(await purgeTrashedPage(archivingBefore(/^delete from "pages"/i), admin, trashed.id)).toEqual({
        ok: false,
        error: "space_archived",
      });
      expect((await readPage(trashed.id))?.deletedAt).toBe(T0);
    });

    it("does not update, delete or move a folder", async () => {
      expect(await updateFolder(archivingBefore(/^update "folders"/i), member, folder.id, { name: "X" })).toEqual({
        ok: false,
        error: "space_archived",
      });
      await unarchive(space.id);
      expect(await deleteFolder(archivingBefore(/^delete from "folders"/i), member, folder.id)).toEqual({
        ok: false,
        error: "space_archived",
      });
      await unarchive(space.id);
      expect(
        await moveFolder(archivingBefore(/^update "folders"/i), member, folder.id, {
          spaceId: other.id,
          parentId: null,
        }, noAck),
      ).toEqual({ ok: false, error: "space_archived" });
      expect(await readFolder(folder.id)).toMatchObject({ name: "Docs", spaceId: space.id });
    });

    it("does not add or delete an attachment, and deletes the object put in R2", async () => {
      expect(
        await createAttachment(archivingBefore(/^insert into "attachments"/i), env.ATTACHMENTS, member, page.id, {
          filename: "file.png",
          contentType: "image/png",
          content: { kind: "bytes", bytes: PNG },
        }),
      ).toEqual({ ok: false, error: "space_archived" });
      expect(await countAttachmentRows()).toBe(0);
      expect(await objectCount()).toBe(0);

      await unarchive(space.id);
      const created = await createAttachment(db, env.ATTACHMENTS, member, page.id, {
        filename: "file.png",
        contentType: "image/png",
        content: { kind: "bytes", bytes: PNG },
      });
      if (!created.ok) throw new Error("upload failed");
      expect(
        await deleteAttachment(archivingBefore(/^delete from "attachments"/i), env.ATTACHMENTS, member, created.attachment.id),
      ).toEqual({ ok: false, error: "space_archived" });
      expect(await db.select().from(attachments).all()).toHaveLength(1);
      expect(await objectCount()).toBe(1);
    });

    it("does not set the top page", async () => {
      expect(await setTopPage(archivingBefore(/INSERT INTO site_settings/i), admin, page.id)).toEqual({
        ok: false,
        error: "space_archived",
      });
      expect(await db.query.siteSettings.findFirst()).toBeUndefined();
    });
  });
});

describe("reads that leave out archived spaces", () => {
  it("leaves archived spaces out of the search of all spaces, but searches one given by space_id", async () => {
    const archived = await insertPage({ spaceId: space.id, title: "needle archived", at: T0 });
    const visible = await insertPage({ spaceId: other.id, title: "needle visible", at: T0 });
    await archive(space.id);
    const all = (await (await send("/api/v1/search?q=needle", { cookies: memberCookies })).json()) as SearchResult;
    expect(all.hits.map((hit) => hit.id)).toEqual([visible.id]);
    const one = (await (
      await send(`/api/v1/search?q=needle&space_id=${space.id}`, { cookies: memberCookies })
    ).json()) as SearchResult;
    expect(one.hits.map((hit) => hit.id)).toEqual([archived.id]);
  });

  it("leaves pages of archived spaces out of the backlinks, except those in the space of the target", async () => {
    const target = await insertPage({ spaceId: space.id, title: "Target", at: T0 });
    const sameSpace = await insertPage({ spaceId: space.id, title: "Same", body: `/pages/${target.id}`, at: T0 });
    const third = await insertSpace("everyone", "Third", T0 + 3);
    const archivedLink = await insertPage({ spaceId: third.id, title: "Archived", body: `/pages/${target.id}`, at: T0 });
    const visible = await insertPage({ spaceId: other.id, title: "Visible", body: `/pages/${target.id}`, at: T0 });
    await archive(space.id);
    await archive(third.id);
    const res = await send(`/api/v1/pages/${target.id}/backlinks`, { cookies: memberCookies });
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as BacklinkList).pages.map((p) => p.id).sort();
    expect(ids).toEqual([sameSpace.id, visible.id].sort());
    expect(ids).not.toContain(archivedLink.id);

    // From a page outside the archived spaces, none of their pages are listed.
    const outsideTarget = await insertPage({ spaceId: other.id, title: "Outside", at: T0 });
    await insertPage({ spaceId: space.id, title: "Hidden", body: `/pages/${outsideTarget.id}`, at: T0 });
    const outside = await send(`/api/v1/pages/${outsideTarget.id}/backlinks`, { cookies: memberCookies });
    expect(((await outside.json()) as BacklinkList).pages).toEqual([]);
  });

  it("hides the top page while its space is archived, and shows it again once unarchived", async () => {
    const page = await insertPage({ spaceId: space.id, title: "Top", at: T0 });
    const set = await send("/api/v1/top-page", { method: "PUT", cookies: adminCookies, json: { page_id: page.id } });
    expect(set.status).toBe(200);
    const topId = async () =>
      ((await (await send("/api/v1/top-page", { cookies: memberCookies })).json()) as TopPage).page?.id ?? null;
    await archive(space.id);
    expect(await topId()).toBeNull();
    await unarchive(space.id);
    expect(await topId()).toBe(page.id);
  });
});
