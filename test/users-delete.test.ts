import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachmentKey } from "../src/attachments/service";
import { attachments, folders, pageRevisions, pages, spaces, users, type SpaceRow, type UserRow } from "../src/db/schema";
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

// Inserts an attachment row and its object in R2 directly, bypassing the API.
async function insertAttachment(pageId: string, createdBy: string | null): Promise<string> {
  const id = crypto.randomUUID();
  await env.ATTACHMENTS.put(attachmentKey(id), new Uint8Array([1, 2, 3]));
  await db
    .insert(attachments)
    .values({ id, pageId, filename: "a.png", contentType: "image/png", size: 3, createdBy, createdAt: T0 })
    .run();
  return id;
}

async function insertRevision(pageId: string, createdBy: string | null): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .insert(pageRevisions)
    .values({ id, pageId, version: 1, title: "Old", body: "", createdBy, createdAt: T0 })
    .run();
  return id;
}

async function objectExists(id: string): Promise<boolean> {
  return (await env.ATTACHMENTS.head(attachmentKey(id))) !== null;
}

async function countSessions(userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?")
    .bind(userId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function countRows(table: string, ids: string[]): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE id IN (${ids.map(() => "?").join(", ")})`,
  )
    .bind(...ids)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

function readUser(id: string) {
  return db.query.users.findFirst({ where: eq(users.id, id) });
}

function deleteRequest(id: string, cookies?: SessionCookies, bucket?: R2Bucket): Promise<Response> {
  return send(`/api/v1/users/${id}`, {
    method: "DELETE",
    cookies,
    env: bucket ? { ATTACHMENTS: bucket } : undefined,
  });
}

// The R2 binding with delete replaced.
function bucketWithDelete(remove: (keys: string | string[]) => Promise<void>): R2Bucket {
  return new Proxy(env.ATTACHMENTS, {
    get(target, prop) {
      if (prop === "delete") return remove;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

// The content of a user's personal space: nested folders, a page in the child folder with a revision and an
// attachment, a top-level page and a page in the trash with an attachment.
async function fillPersonalSpace(user: UserRow) {
  const space = await personalSpaceOf(user);
  const parent = await insertFolder({ spaceId: space.id, createdBy: user.id });
  const child = await insertFolder({ spaceId: space.id, parentId: parent.id, createdBy: user.id });
  const inFolder = await insertPage({ spaceId: space.id, folderId: child.id, createdBy: user.id });
  const topLevel = await insertPage({ spaceId: space.id, createdBy: user.id });
  const trashed = await insertPage({ spaceId: space.id, createdBy: user.id, deletedAt: T0, deletedBy: user.id });
  const revision = await insertRevision(inFolder.id, user.id);
  const attachmentIds = [await insertAttachment(inFolder.id, user.id), await insertAttachment(trashed.id, user.id)];
  return {
    space,
    folderIds: [parent.id, child.id],
    pageIds: [inFolder.id, topLevel.id, trashed.id],
    revisionIds: [revision],
    attachmentIds,
  };
}

let admin: UserRow;
let member: UserRow;
let adminCookies: SessionCookies;
let memberCookies: SessionCookies;
let everyone: SpaceRow;

beforeEach(async () => {
  await resetDb();
  await resetAttachments();
  admin = await createUser({ email: "admin@example.com", role: "admin", createdAt: T0 });
  member = await createUser({ email: "member@example.com", role: "member", createdAt: T0 });
  adminCookies = await login(admin.email);
  memberCookies = await login(member.email);
  everyone = await insertSpace("everyone", "Everyone");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DELETE /api/v1/users/:id", () => {
  it("deletes the user with their sessions and their personal space with everything in it", async () => {
    await login(member.email);
    const content = await fillPersonalSpace(member);
    expect(await countSessions(member.id)).toBe(2);

    const res = await deleteRequest(member.id, adminCookies);
    expect(res.status).toBe(204);

    expect(await readUser(member.id)).toBeUndefined();
    expect(await countSessions(member.id)).toBe(0);
    expect(await countRows("spaces", [content.space.id])).toBe(0);
    expect(await countRows("pages", content.pageIds)).toBe(0);
    expect(await countRows("folders", content.folderIds)).toBe(0);
    expect(await countRows("page_revisions", content.revisionIds)).toBe(0);
    expect(await countRows("attachments", content.attachmentIds)).toBe(0);
    for (const id of content.attachmentIds) expect(await objectExists(id)).toBe(false);
  });

  it("keeps the content of other spaces that the user created or updated", async () => {
    const folder = await insertFolder({ spaceId: everyone.id, createdBy: member.id });
    const page = await insertPage({ spaceId: everyone.id, folderId: folder.id, createdBy: member.id });
    const revision = await insertRevision(page.id, member.id);
    const attachment = await insertAttachment(page.id, member.id);
    const trashed = await insertPage({ spaceId: everyone.id, deletedAt: T0, deletedBy: member.id });

    expect((await deleteRequest(member.id, adminCookies)).status).toBe(204);

    expect(await db.query.pages.findFirst({ where: eq(pages.id, page.id) })).toMatchObject({
      spaceId: everyone.id,
      createdBy: null,
      updatedBy: null,
    });
    expect(await db.query.pageRevisions.findFirst({ where: eq(pageRevisions.id, revision) })).toMatchObject({
      createdBy: null,
    });
    expect(await db.query.attachments.findFirst({ where: eq(attachments.id, attachment) })).toMatchObject({
      pageId: page.id,
      createdBy: null,
    });
    expect(await objectExists(attachment)).toBe(true);
    expect(await db.query.folders.findFirst({ where: eq(folders.id, folder.id) })).toMatchObject({
      createdBy: null,
      updatedBy: null,
    });
    expect(await db.query.pages.findFirst({ where: eq(pages.id, trashed.id) })).toMatchObject({
      deletedBy: member.id,
    });
  });

  it("leaves the personal spaces of other users alone", async () => {
    const other = await createUser({ email: "other@example.com", createdAt: T0 });
    const otherContent = await fillPersonalSpace(other);
    const adminContent = await fillPersonalSpace(admin);
    await fillPersonalSpace(member);

    expect((await deleteRequest(member.id, adminCookies)).status).toBe(204);

    for (const content of [otherContent, adminContent]) {
      expect(await countRows("spaces", [content.space.id])).toBe(1);
      expect(await countRows("pages", content.pageIds)).toBe(3);
      expect(await countRows("folders", content.folderIds)).toBe(2);
      expect(await countRows("page_revisions", content.revisionIds)).toBe(1);
      expect(await countRows("attachments", content.attachmentIds)).toBe(2);
      for (const id of content.attachmentIds) expect(await objectExists(id)).toBe(true);
    }
  });

  it("signs the deleted user out", async () => {
    expect((await send("/api/v1/me", { cookies: memberCookies })).status).toBe(200);
    expect((await deleteRequest(member.id, adminCookies)).status).toBe(204);
    expect((await send("/api/v1/me", { cookies: memberCookies })).status).toBe(401);
  });

  it("rejects the requester themselves, an unknown user, members and anonymous requests", async () => {
    const self = await deleteRequest(admin.id, adminCookies);
    expect(self.status).toBe(400);
    expect(await errorCode(self)).toBe("cannot_delete_self");

    const unknown = await deleteRequest(crypto.randomUUID(), adminCookies);
    expect(unknown.status).toBe(404);
    expect(await errorCode(unknown)).toBe("not_found");

    const byMember = await deleteRequest(admin.id, memberCookies);
    expect(byMember.status).toBe(403);
    expect(await errorCode(byMember)).toBe("forbidden");

    expect((await deleteRequest(member.id)).status).toBe(401);

    expect(await readUser(admin.id)).toBeDefined();
    expect(await readUser(member.id)).toBeDefined();
  });

  it("lets an admin delete another admin when there are two", async () => {
    const second = await createUser({ email: "second@example.com", role: "admin", createdAt: T0 });
    expect((await deleteRequest(second.id, adminCookies)).status).toBe(204);
    expect(await readUser(second.id)).toBeUndefined();
  });

  it("still answers 204 when the objects in R2 cannot be deleted", async () => {
    const content = await fillPersonalSpace(member);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const bucket = bucketWithDelete(() => Promise.reject(new Error("R2 is down")));

    const res = await deleteRequest(member.id, adminCookies, bucket);
    expect(res.status).toBe(204);
    expect(await readUser(member.id)).toBeUndefined();
    expect(await countRows("attachments", content.attachmentIds)).toBe(0);
    // Left for the scheduled job.
    for (const id of content.attachmentIds) expect(await objectExists(id)).toBe(true);
  });

  it("does not call R2 when the user has no attachments", async () => {
    await insertPage({ spaceId: (await personalSpaceOf(member)).id, createdBy: member.id });
    const remove = vi.fn(() => Promise.resolve());
    expect((await deleteRequest(member.id, adminCookies, bucketWithDelete(remove))).status).toBe(204);
    expect(remove).not.toHaveBeenCalled();
  });
});

// The statements of the delete batch run first, from the userDeleteStatements hook of src/core.ts. The data is changed
// right before that batch, after the checks of DELETE /api/v1/users/:id.
describe("DELETE /api/v1/users/:id under a race", () => {
  it("deletes nothing when the requester stops being an admin after the check", async () => {
    const target = await createUser({ email: "target@example.com", role: "admin", createdAt: T0 });
    await login(target.email);
    const content = await fillPersonalSpace(target);
    const raced = dbChangingBefore(/^DELETE FROM attachments/i, () =>
      env.DB.prepare("UPDATE users SET role = 'member' WHERE id = ?").bind(admin.id).run(),
    );

    const res = await send(`/api/v1/users/${target.id}`, {
      method: "DELETE",
      cookies: adminCookies,
      env: { DB: raced.$client },
    });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("last_admin");

    expect(await readUser(target.id)).toMatchObject({ role: "admin" });
    expect(await countSessions(target.id)).toBe(1);
    expect(await countRows("spaces", [content.space.id])).toBe(1);
    expect(await countRows("pages", content.pageIds)).toBe(3);
    expect(await countRows("folders", content.folderIds)).toBe(2);
    expect(await countRows("page_revisions", content.revisionIds)).toBe(1);
    expect(await countRows("attachments", content.attachmentIds)).toBe(2);
    for (const id of content.attachmentIds) expect(await objectExists(id)).toBe(true);
  });

  it("keeps a page moved out of the personal space after the check, with its attachment", async () => {
    const space = await personalSpaceOf(member);
    const moved = await insertPage({ spaceId: space.id, createdBy: member.id });
    const movedAttachment = await insertAttachment(moved.id, member.id);
    const staying = await insertPage({ spaceId: space.id, createdBy: member.id });
    const stayingAttachment = await insertAttachment(staying.id, member.id);
    const raced = dbChangingBefore(/^DELETE FROM attachments/i, () =>
      env.DB.prepare("UPDATE pages SET space_id = ? WHERE id = ?").bind(everyone.id, moved.id).run(),
    );

    const res = await send(`/api/v1/users/${member.id}`, {
      method: "DELETE",
      cookies: adminCookies,
      env: { DB: raced.$client },
    });
    expect(res.status).toBe(204);

    expect(await readUser(member.id)).toBeUndefined();
    expect(await db.query.pages.findFirst({ where: eq(pages.id, moved.id) })).toMatchObject({
      spaceId: everyone.id,
      createdBy: null,
    });
    expect(await countRows("attachments", [movedAttachment])).toBe(1);
    expect(await objectExists(movedAttachment)).toBe(true);
    expect(await countRows("pages", [staying.id])).toBe(0);
    expect(await countRows("attachments", [stayingAttachment])).toBe(0);
    expect(await objectExists(stayingAttachment)).toBe(false);
  });
});
