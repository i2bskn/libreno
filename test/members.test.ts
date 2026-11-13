import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BacklinkList, SearchResult, Space, SpaceList, SpaceMembers } from "../src/api/types";
import { clock } from "@i2bskn/workers-app-core";
import { attachmentKey } from "../src/attachments/service";
import { attachments, spaceMembers, spaces, type SpaceRow, type UserRow } from "../src/db/schema";
import {
  countSpaces,
  createUser,
  db,
  insertFolder,
  insertPage,
  login,
  resetAttachments,
  resetDb,
  send,
  type SessionCookies,
} from "./helpers";

const T0 = Date.UTC(2026, 9, 1);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function setNow(now: number) {
  vi.spyOn(clock, "now").mockReturnValue(now);
}

async function insertSpace(
  kind: "everyone" | "admin" | "members",
  name: string,
  memberIds: string[] = [],
): Promise<SpaceRow> {
  const [space] = await db
    .insert(spaces)
    .values({ id: crypto.randomUUID(), kind, name, createdAt: T0, updatedAt: T0 })
    .returning();
  if (!space) throw new Error("failed to create space");
  if (memberIds.length > 0) {
    await db.insert(spaceMembers).values(memberIds.map((userId) => ({ spaceId: space.id, userId, createdAt: T0 })));
  }
  return space;
}

async function personalSpaceOf(user: UserRow): Promise<SpaceRow> {
  const space = await db.query.spaces.findFirst({ where: eq(spaces.ownerUserId, user.id) });
  if (!space) throw new Error("personal space not found");
  return space;
}

async function memberIdsOf(spaceId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: spaceMembers.userId })
    .from(spaceMembers)
    .where(eq(spaceMembers.spaceId, spaceId))
    .orderBy(spaceMembers.userId)
    .all();
  return rows.map((row) => row.userId);
}

async function countMemberRows(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM space_members").first<{ count: number }>();
  return row?.count ?? 0;
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

let admin: UserRow;
let member: UserRow;
let other: UserRow;
let adminCookies: SessionCookies;
let memberCookies: SessionCookies;

beforeEach(async () => {
  await resetDb();
  await resetAttachments();
  setNow(T0);
  admin = await createUser({ email: "admin@example.com", role: "admin", createdAt: T0 - 3000 });
  member = await createUser({ email: "member@example.com", role: "member", createdAt: T0 - 2000 });
  other = await createUser({ email: "other@example.com", role: "member", createdAt: T0 - 1000 });
  adminCookies = await login(admin.email);
  memberCookies = await login(member.email);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/v1/spaces with kind members", () => {
  it("creates a members space with its members", async () => {
    const res = await send("/api/v1/spaces", {
      cookies: adminCookies,
      json: { kind: "members", name: " Team ", member_ids: [member.id, admin.id] },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Space;
    expect(body).toEqual({
      id: expect.stringMatching(UUID_V4),
      kind: "members",
      name: "Team",
      sort_order: 0,
      archived_at: null,
      created_at: T0,
      updated_at: T0,
    });
    expect(await memberIdsOf(body.id)).toEqual([admin.id, member.id].sort());
    expect((await send(`/api/v1/spaces/${body.id}`, { cookies: memberCookies })).status).toBe(200);
  });

  it("creates a members space without members when member_ids is missing or empty", async () => {
    for (const [name, json] of [
      ["Missing", { kind: "members", name: "Missing" }],
      ["Empty", { kind: "members", name: "Empty", member_ids: [] }],
    ] as const) {
      const res = await send("/api/v1/spaces", { cookies: adminCookies, json });
      expect(res.status, name).toBe(201);
      expect(await memberIdsOf(((await res.json()) as Space).id)).toEqual([]);
    }
  });

  it("removes duplicate member IDs", async () => {
    const res = await send("/api/v1/spaces", {
      cookies: adminCookies,
      json: { kind: "members", name: "Team", member_ids: [member.id, member.id, other.id, member.id] },
    });
    expect(res.status).toBe(201);
    expect(await memberIdsOf(((await res.json()) as Space).id)).toEqual([member.id, other.id].sort());
  });

  it("validates member_ids after kind and name", async () => {
    const cases: [unknown, string][] = [
      [{ kind: "everyone", name: "X", member_ids: [] }, "invalid_member_ids"],
      [{ kind: "admin", name: "X", member_ids: null }, "invalid_member_ids"],
      [{ kind: "members", name: "X", member_ids: null }, "invalid_member_ids"],
      [{ kind: "members", name: "X", member_ids: member.id }, "invalid_member_ids"],
      [{ kind: "members", name: "X", member_ids: [1] }, "invalid_member_ids"],
      [{ kind: "members", name: "X", member_ids: [""] }, "invalid_member_ids"],
      [{ kind: "members", name: "X", member_ids: ["a".repeat(101)] }, "invalid_member_ids"],
      [{ kind: "members", name: "X", member_ids: Array.from({ length: 501 }, (_, i) => `user-${i}`) }, "too_many_members"],
      [{ kind: "members", name: "   ", member_ids: null }, "invalid_name"],
      [{ kind: "other", name: "X", member_ids: null }, "invalid_kind"],
    ];
    for (const [json, code] of cases) {
      const res = await send("/api/v1/spaces", { cookies: adminCookies, json });
      expect(res.status, JSON.stringify(json).slice(0, 80)).toBe(400);
      expect(await errorCode(res)).toBe(code);
    }
    expect(await countSpaces()).toBe(3);
  });

  it("accepts 500 member IDs after removing duplicates", async () => {
    const ids = [member.id, ...Array.from({ length: 499 }, (_, i) => `user-${i}`)];
    const res = await send("/api/v1/spaces", {
      cookies: adminCookies,
      json: { kind: "members", name: "X", member_ids: [...ids, member.id] },
    });
    // The shape is valid; the unknown users are rejected afterwards.
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("member_not_found");
  });

  it("returns 400 member_not_found for an unknown user and creates nothing", async () => {
    const res = await send("/api/v1/spaces", {
      cookies: adminCookies,
      json: { kind: "members", name: "Team", member_ids: [member.id, "missing"] },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "member_not_found",
        message: "存在しないユーザーが含まれています。画面を読み込み直してください",
      },
    });
    expect(await countSpaces()).toBe(3);
    expect(await countMemberRows()).toBe(0);
  });

  it("returns 409 name_taken for a duplicate name without inserting the members", async () => {
    await insertSpace("everyone", "Shared");
    const res = await send("/api/v1/spaces", {
      cookies: adminCookies,
      json: { kind: "members", name: "Shared", member_ids: [member.id] },
    });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("name_taken");
    expect(await countMemberRows()).toBe(0);
  });

  it("returns 403 to members", async () => {
    const res = await send("/api/v1/spaces", {
      cookies: memberCookies,
      json: { kind: "members", name: "Team", member_ids: [member.id] },
    });
    expect(res.status).toBe(403);
    expect(await countSpaces()).toBe(3);
  });
});

describe("GET /api/v1/spaces/:id/members", () => {
  it("returns the members in the order they were added", async () => {
    const space = await insertSpace("members", "Team");
    await db.insert(spaceMembers).values([
      { spaceId: space.id, userId: other.id, createdAt: T0 + 2 },
      { spaceId: space.id, userId: member.id, createdAt: T0 + 1 },
      { spaceId: space.id, userId: admin.id, createdAt: T0 + 2 },
    ]);
    const res = await send(`/api/v1/spaces/${space.id}/members`, { cookies: adminCookies });
    expect(res.status).toBe(200);
    const sameTime = [other.id, admin.id].sort();
    expect((await res.json()) as SpaceMembers).toEqual({ user_ids: [member.id, ...sameTime] });
  });

  it("returns the members of an archived space", async () => {
    const space = await insertSpace("members", "Team", [member.id]);
    await db.update(spaces).set({ archivedAt: T0 }).where(eq(spaces.id, space.id));
    const res = await send(`/api/v1/spaces/${space.id}/members`, { cookies: adminCookies });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_ids: [member.id] });
  });

  it("returns 403 to members, even to a member of the space", async () => {
    const space = await insertSpace("members", "Team", [member.id]);
    const res = await send(`/api/v1/spaces/${space.id}/members`, { cookies: memberCookies });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("forbidden");
  });

  it("returns 400 for other kinds and 404 for another user's personal space and unknown spaces", async () => {
    for (const space of [await insertSpace("everyone", "Everyone"), await insertSpace("admin", "Admins")]) {
      const res = await send(`/api/v1/spaces/${space.id}/members`, { cookies: adminCookies });
      expect(res.status, space.kind).toBe(400);
      expect(await errorCode(res)).toBe("not_members_space");
    }
    const own = await send(`/api/v1/spaces/${(await personalSpaceOf(admin)).id}/members`, { cookies: adminCookies });
    expect(own.status).toBe(400);
    expect(await errorCode(own)).toBe("not_members_space");
    for (const id of [(await personalSpaceOf(member)).id, "missing"]) {
      const res = await send(`/api/v1/spaces/${id}/members`, { cookies: adminCookies });
      expect(res.status, id).toBe(404);
      expect(await errorCode(res)).toBe("not_found");
    }
  });
});

describe("PUT /api/v1/spaces/:id/members", () => {
  function put(spaceId: string, json: unknown, cookies = adminCookies): Promise<Response> {
    return send(`/api/v1/spaces/${spaceId}/members`, { method: "PUT", cookies, json });
  }

  it("replaces the members without changing updated_at", async () => {
    const space = await insertSpace("members", "Team", [member.id, admin.id]);
    setNow(T0 + 1000);
    const res = await put(space.id, { user_ids: [other.id, member.id, other.id] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as SpaceMembers).user_ids.sort()).toEqual([member.id, other.id].sort());
    expect(await memberIdsOf(space.id)).toEqual([member.id, other.id].sort());
    expect((await db.query.spaces.findFirst({ where: eq(spaces.id, space.id) }))?.updatedAt).toBe(T0);
  });

  it("removes every member with an empty list", async () => {
    const space = await insertSpace("members", "Team", [member.id, other.id]);
    const res = await put(space.id, { user_ids: [] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_ids: [] });
    expect(await memberIdsOf(space.id)).toEqual([]);
  });

  it("changes the members of an archived space", async () => {
    const space = await insertSpace("members", "Team");
    await db.update(spaces).set({ archivedAt: T0 }).where(eq(spaces.id, space.id));
    const res = await put(space.id, { user_ids: [member.id] });
    expect(res.status).toBe(200);
    expect(await memberIdsOf(space.id)).toEqual([member.id]);
  });

  it("validates the body like the creation and changes nothing", async () => {
    const space = await insertSpace("members", "Team", [member.id]);
    const cases: [unknown, string][] = [
      ["not json", "invalid_body"],
      [{}, "invalid_member_ids"],
      [{ user_ids: null }, "invalid_member_ids"],
      [{ user_ids: [1] }, "invalid_member_ids"],
      [{ user_ids: [""] }, "invalid_member_ids"],
      [{ user_ids: Array.from({ length: 501 }, (_, i) => `user-${i}`) }, "too_many_members"],
      [{ user_ids: [other.id, "missing"] }, "member_not_found"],
    ];
    for (const [json, code] of cases) {
      const res = await put(space.id, json);
      expect(res.status, JSON.stringify(json).slice(0, 80)).toBe(400);
      expect(await errorCode(res)).toBe(code);
    }
    expect(await memberIdsOf(space.id)).toEqual([member.id]);
  });

  it("returns 403 to members", async () => {
    const space = await insertSpace("members", "Team", [member.id]);
    const res = await put(space.id, { user_ids: [member.id, other.id] }, memberCookies);
    expect(res.status).toBe(403);
    expect(await memberIdsOf(space.id)).toEqual([member.id]);
  });

  it("returns 400 for other kinds and 404 for unknown spaces", async () => {
    const everyone = await insertSpace("everyone", "Everyone");
    const notMembers = await put(everyone.id, { user_ids: [member.id] });
    expect(notMembers.status).toBe(400);
    expect(await errorCode(notMembers)).toBe("not_members_space");
    for (const id of [(await personalSpaceOf(member)).id, "missing"]) {
      const res = await put(id, { user_ids: [member.id] });
      expect(res.status, id).toBe(404);
      expect(await errorCode(res)).toBe("not_found");
    }
    expect(await countMemberRows()).toBe(0);
  });
});

describe("removing a user from the members", () => {
  it("hides the space and its content through the REST API from the next request", async () => {
    const space = await insertSpace("members", "Team", [member.id]);
    const folder = await insertFolder({ spaceId: space.id });
    const target = await insertPage({ spaceId: space.id, folderId: folder.id, title: "Secret target", body: "target" });
    const linking = await insertPage({ spaceId: space.id, title: "Linking", body: `[t](/pages/${target.id})` });
    const attachmentId = crypto.randomUUID();
    await env.ATTACHMENTS.put(attachmentKey(attachmentId), new Uint8Array([1, 2, 3]));
    await db
      .insert(attachments)
      .values({ id: attachmentId, pageId: target.id, filename: "a.png", contentType: "image/png", size: 3, createdAt: T0 })
      .run();

    const listIds = async () =>
      ((await (await send("/api/v1/spaces", { cookies: memberCookies })).json()) as SpaceList).spaces.map((s) => s.id);
    const searchIds = async () =>
      ((await (await send("/api/v1/search?q=Secret", { cookies: memberCookies })).json()) as SearchResult).hits.map(
        (hit) => hit.id,
      );
    const statuses = async () => ({
      space: (await send(`/api/v1/spaces/${space.id}`, { cookies: memberCookies })).status,
      pages: (await send(`/api/v1/spaces/${space.id}/pages`, { cookies: memberCookies })).status,
      page: (await send(`/api/v1/pages/${target.id}`, { cookies: memberCookies })).status,
      folder: (await send(`/api/v1/folders/${folder.id}`, { cookies: memberCookies })).status,
      searchInSpace: (await send(`/api/v1/search?q=Secret&space_id=${space.id}`, { cookies: memberCookies })).status,
      backlinks: (await send(`/api/v1/pages/${target.id}/backlinks`, { cookies: memberCookies })).status,
      attachment: (await send(`/api/v1/attachments/${attachmentId}`, { cookies: memberCookies })).status,
    });

    expect(await listIds()).toContain(space.id);
    expect(await searchIds()).toEqual([target.id]);
    const backlinks = (await (
      await send(`/api/v1/pages/${target.id}/backlinks`, { cookies: memberCookies })
    ).json()) as BacklinkList;
    expect(backlinks.pages.map((p) => p.id)).toEqual([linking.id]);
    expect(await statuses()).toEqual({
      space: 200,
      pages: 200,
      page: 200,
      folder: 200,
      searchInSpace: 200,
      backlinks: 200,
      attachment: 200,
    });

    const res = await send(`/api/v1/spaces/${space.id}/members`, {
      method: "PUT",
      cookies: adminCookies,
      json: { user_ids: [other.id] },
    });
    expect(res.status).toBe(200);

    expect(await listIds()).not.toContain(space.id);
    expect(await searchIds()).toEqual([]);
    expect(await statuses()).toEqual({
      space: 404,
      pages: 404,
      page: 404,
      folder: 404,
      searchInSpace: 404,
      backlinks: 404,
      attachment: 404,
    });
  });
});
