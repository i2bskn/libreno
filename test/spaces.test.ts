import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import type { Space, SpaceList } from "../src/api/types";
import { clock, isUniqueViolation } from "@i2bskn/workers-app-core";
import { spaces, users, type SpaceRow, type UserRow } from "../src/db/schema";
import { accessibleSpacesWhere, canAccessSpace } from "../src/spaces/access";
import { insertPersonalSpaceStatement } from "../src/spaces/queries";
import { core } from "../src/core";
import {
  appDb,
  countFolders,
  countPages,
  countPersonalSpaces,
  countSpaces,
  createUser,
  createUserWithoutSpace,
  db,
  insertFolder,
  insertPage,
  login,
  resetDb,
  send,
  sessionCookies,
  type SessionCookies,
} from "./helpers";

const T0 = Date.UTC(2026, 9, 1);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function setNow(now: number) {
  vi.spyOn(clock, "now").mockReturnValue(now);
}

async function insertSpace(
  kind: "everyone" | "admin",
  name: string,
  createdAt = T0,
  sortOrder = 0,
): Promise<SpaceRow> {
  const [space] = await db
    .insert(spaces)
    .values({ id: crypto.randomUUID(), kind, name, sortOrder, createdAt, updatedAt: createdAt })
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

let admin: UserRow;
let member: UserRow;
let adminCookies: SessionCookies;
let memberCookies: SessionCookies;

beforeEach(async () => {
  await resetDb();
  setNow(T0);
  admin = await createUser({ email: "admin@example.com", role: "admin", createdAt: T0 - 2000 });
  member = await createUser({ email: "member@example.com", role: "member", createdAt: T0 - 1000 });
  adminCookies = await login(admin.email);
  memberCookies = await login(member.email);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("space access", () => {
  it("gives the same answer from canAccessSpace and accessibleSpacesWhere", async () => {
    const everyone = await insertSpace("everyone", "Everyone");
    const adminOnly = await insertSpace("admin", "Admins");
    const adminPersonal = await personalSpaceOf(admin);
    const memberPersonal = await personalSpaceOf(member);

    const table: [UserRow, SpaceRow, boolean][] = [
      [admin, everyone, true],
      [admin, adminOnly, true],
      [admin, adminPersonal, true],
      [admin, memberPersonal, false],
      [member, everyone, true],
      [member, adminOnly, false],
      [member, memberPersonal, true],
      [member, adminPersonal, false],
    ];
    for (const [viewer, space, expected] of table) {
      expect(canAccessSpace(viewer, space), `${viewer.role} -> ${space.kind}`).toBe(expected);
      const rows = await db.select({ id: spaces.id }).from(spaces).where(accessibleSpacesWhere(viewer)).all();
      expect(rows.some((r) => r.id === space.id), `${viewer.role} -> ${space.kind} (sql)`).toBe(expected);
    }
  });
});

describe("GET /api/v1/spaces", () => {
  it("lists only accessible spaces in created_at order, with the personal space last", async () => {
    const everyone = await insertSpace("everyone", "Everyone", T0 + 1);
    const adminOnly = await insertSpace("admin", "Admins", T0 + 2);
    const adminPersonal = await personalSpaceOf(admin);
    const memberPersonal = await personalSpaceOf(member);

    const asMember = await send("/api/v1/spaces", { cookies: memberCookies });
    expect(asMember.status).toBe(200);
    expect(((await asMember.json()) as SpaceList).spaces.map((s) => s.id)).toEqual([everyone.id, memberPersonal.id]);

    const asAdmin = await send("/api/v1/spaces", { cookies: adminCookies });
    const body = (await asAdmin.json()) as SpaceList;
    expect(body.spaces.map((s) => s.id)).toEqual([everyone.id, adminOnly.id, adminPersonal.id]);
    expect(body.spaces[2]).toEqual({
      id: adminPersonal.id,
      kind: "personal",
      name: null,
      sort_order: 0,
      archived_at: null,
      created_at: admin.createdAt,
      updated_at: admin.createdAt,
    });
  });

  it("lists spaces by sort_order, then created_at, with the personal space last whatever its sort_order", async () => {
    const third = await insertSpace("everyone", "Third", T0 + 1, 5);
    const first = await insertSpace("admin", "First", T0 + 2, -3);
    const second = await insertSpace("everyone", "Second", T0 + 3, 0);
    const fourth = await insertSpace("everyone", "Fourth", T0 + 4, 5);
    const adminPersonal = await personalSpaceOf(admin);
    await db.update(spaces).set({ sortOrder: -10 }).where(eq(spaces.id, adminPersonal.id));

    const res = await send("/api/v1/spaces", { cookies: adminCookies });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SpaceList;
    expect(body.spaces.map((s) => s.id)).toEqual([first.id, second.id, third.id, fourth.id, adminPersonal.id]);
    expect(body.spaces.map((s) => s.sort_order)).toEqual([-3, 0, 5, 5, -10]);
  });

  it("returns 401 without a session", async () => {
    expect((await send("/api/v1/spaces")).status).toBe(401);
  });

  it("hides admin spaces once the role is changed to member", async () => {
    await createUser({ email: "second-admin@example.com", role: "admin" });
    const adminOnly = await insertSpace("admin", "Admins");
    const listIds = async () =>
      ((await (await send("/api/v1/spaces", { cookies: adminCookies })).json()) as SpaceList).spaces.map((s) => s.id);
    expect(await listIds()).toContain(adminOnly.id);

    const demote = await send(`/api/v1/users/${admin.id}`, { method: "PATCH", cookies: adminCookies, json: { role: "member" } });
    expect(demote.status).toBe(200);
    expect(await listIds()).not.toContain(adminOnly.id);
    expect((await send(`/api/v1/spaces/${adminOnly.id}`, { cookies: adminCookies })).status).toBe(404);
  });
});

describe("GET /api/v1/spaces/:id", () => {
  it("returns an accessible space", async () => {
    const everyone = await insertSpace("everyone", "Everyone");
    const res = await send(`/api/v1/spaces/${everyone.id}`, { cookies: memberCookies });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: everyone.id,
      kind: "everyone",
      name: "Everyone",
      sort_order: 0,
      archived_at: null,
      created_at: T0,
      updated_at: T0,
    });
  });

  it("returns 404 for inaccessible and unknown spaces", async () => {
    const adminOnly = await insertSpace("admin", "Admins");
    const memberPersonal = await personalSpaceOf(member);
    for (const [cookies, id] of [
      [memberCookies, adminOnly.id],
      [memberCookies, (await personalSpaceOf(admin)).id],
      [adminCookies, memberPersonal.id],
      [adminCookies, "nope"],
    ] as const) {
      const res = await send(`/api/v1/spaces/${id}`, { cookies });
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe("not_found");
    }
  });
});

describe("POST /api/v1/spaces", () => {
  it("creates a space with a trimmed name", async () => {
    const res = await send("/api/v1/spaces", { cookies: adminCookies, json: { kind: "admin", name: "  Admins  " } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Space;
    expect(body).toEqual({
      id: expect.stringMatching(UUID_V4),
      kind: "admin",
      name: "Admins",
      sort_order: 0,
      archived_at: null,
      created_at: T0,
      updated_at: T0,
    });
    const row = await db.query.spaces.findFirst({ where: eq(spaces.id, body.id) });
    expect(row).toMatchObject({ kind: "admin", name: "Admins", ownerUserId: null });
  });

  it("accepts a name of 100 code points", async () => {
    const name = "あ".repeat(99) + "😀";
    const res = await send("/api/v1/spaces", { cookies: adminCookies, json: { kind: "everyone", name } });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Space).name).toBe(name);
  });

  it("returns 403 to members", async () => {
    const res = await send("/api/v1/spaces", { cookies: memberCookies, json: { kind: "everyone", name: "X" } });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("forbidden");
  });

  it("validates input", async () => {
    const cases: [unknown, string][] = [
      ["not json", "invalid_body"],
      [{ kind: "personal", name: "Mine" }, "invalid_kind"],
      [{ kind: "other", name: "X" }, "invalid_kind"],
      [{ name: "X" }, "invalid_kind"],
      [{ kind: "personal", name: "" }, "invalid_kind"],
      [{ kind: "everyone", name: "   " }, "invalid_name"],
      [{ kind: "everyone", name: "a".repeat(101) }, "invalid_name"],
      [{ kind: "everyone", name: "a\nb" }, "invalid_name"],
      [{ kind: "everyone", name: "a\tb" }, "invalid_name"],
      [{ kind: "everyone", name: 1 }, "invalid_name"],
      [{ kind: "everyone" }, "invalid_name"],
    ];
    for (const [json, code] of cases) {
      const res = await send("/api/v1/spaces", { cookies: adminCookies, json });
      expect(res.status, JSON.stringify(json)).toBe(400);
      expect(await errorCode(res)).toBe(code);
    }
    expect(await countSpaces()).toBe(2);
  });

  it("returns 409 name_taken for a duplicate name across kinds", async () => {
    await insertSpace("everyone", "Shared");
    const res = await send("/api/v1/spaces", { cookies: adminCookies, json: { kind: "admin", name: " Shared " } });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("name_taken");
  });
});

describe("PATCH /api/v1/spaces/:id", () => {
  it("renames a space and updates updated_at", async () => {
    const space = await insertSpace("everyone", "Old");
    setNow(T0 + 1000);
    const res = await send(`/api/v1/spaces/${space.id}`, { method: "PATCH", cookies: adminCookies, json: { name: " New " } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: space.id,
      kind: "everyone",
      name: "New",
      sort_order: 0,
      archived_at: null,
      created_at: T0,
      updated_at: T0 + 1000,
    });
  });

  it("changes only sort_order and updates updated_at", async () => {
    const space = await insertSpace("everyone", "Ordered");
    setNow(T0 + 1000);
    const res = await send(`/api/v1/spaces/${space.id}`, { method: "PATCH", cookies: adminCookies, json: { sort_order: 3 } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: space.id,
      kind: "everyone",
      name: "Ordered",
      sort_order: 3,
      archived_at: null,
      created_at: T0,
      updated_at: T0 + 1000,
    });
    expect(await db.query.spaces.findFirst({ where: eq(spaces.id, space.id) })).toMatchObject({
      name: "Ordered",
      sortOrder: 3,
      updatedAt: T0 + 1000,
    });
  });

  it("changes name and sort_order together", async () => {
    const space = await insertSpace("everyone", "Old");
    setNow(T0 + 1000);
    const res = await send(`/api/v1/spaces/${space.id}`, {
      method: "PATCH",
      cookies: adminCookies,
      json: { name: "New", sort_order: -2 },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "New", sort_order: -2, updated_at: T0 + 1000 });
  });

  it("returns 200 without writing for the same sort_order", async () => {
    const space = await insertSpace("everyone", "Same", T0, 4);
    setNow(T0 + 1000);
    const res = await send(`/api/v1/spaces/${space.id}`, {
      method: "PATCH",
      cookies: adminCookies,
      json: { name: "Same", sort_order: 4 },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sort_order: 4, updated_at: T0 });
    expect((await db.query.spaces.findFirst({ where: eq(spaces.id, space.id) }))?.updatedAt).toBe(T0);
  });

  it("accepts sort_order at the bounds", async () => {
    const space = await insertSpace("everyone", "Bounds");
    for (const sortOrder of [1000000, -1000000]) {
      const res = await send(`/api/v1/spaces/${space.id}`, {
        method: "PATCH",
        cookies: adminCookies,
        json: { sort_order: sortOrder },
      });
      expect(res.status, String(sortOrder)).toBe(200);
      expect(((await res.json()) as Space).sort_order).toBe(sortOrder);
    }
  });

  it("returns 400 empty_update and invalid_sort_order", async () => {
    const space = await insertSpace("everyone", "Everyone");
    const cases: [unknown, string][] = [
      [{}, "empty_update"],
      [{ sort_order: "1" }, "invalid_sort_order"],
      [{ sort_order: null }, "invalid_sort_order"],
      [{ sort_order: 1.5 }, "invalid_sort_order"],
      [{ sort_order: 1000001 }, "invalid_sort_order"],
      [{ sort_order: -1000001 }, "invalid_sort_order"],
      [{ sort_order: 1e7 }, "invalid_sort_order"],
      [{ name: " ", sort_order: 1.5 }, "invalid_name"],
    ];
    for (const [json, code] of cases) {
      const res = await send(`/api/v1/spaces/${space.id}`, { method: "PATCH", cookies: adminCookies, json });
      expect(res.status, JSON.stringify(json)).toBe(400);
      expect(await errorCode(res), JSON.stringify(json)).toBe(code);
    }
    expect(await db.query.spaces.findFirst({ where: eq(spaces.id, space.id) })).toEqual(space);
  });

  it("returns 403 for sort_order on the personal space and to members", async () => {
    const personal = await send(`/api/v1/spaces/${(await personalSpaceOf(admin)).id}`, {
      method: "PATCH",
      cookies: adminCookies,
      json: { sort_order: 1 },
    });
    expect(personal.status).toBe(403);
    expect(await errorCode(personal)).toBe("forbidden");

    const space = await insertSpace("everyone", "Everyone");
    const asMember = await send(`/api/v1/spaces/${space.id}`, {
      method: "PATCH",
      cookies: memberCookies,
      json: { sort_order: 1 },
    });
    expect(asMember.status).toBe(403);
    expect((await db.query.spaces.findFirst({ where: eq(spaces.id, space.id) }))?.sortOrder).toBe(0);
  });

  it("returns 200 without writing for the same name", async () => {
    const space = await insertSpace("everyone", "Same");
    setNow(T0 + 1000);
    const res = await send(`/api/v1/spaces/${space.id}`, { method: "PATCH", cookies: adminCookies, json: { name: "Same" } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Space).updated_at).toBe(T0);
    expect((await db.query.spaces.findFirst({ where: eq(spaces.id, space.id) }))?.updatedAt).toBe(T0);
  });

  it("returns 409 name_taken for a duplicate name", async () => {
    await insertSpace("admin", "Taken");
    const space = await insertSpace("everyone", "Mine");
    const res = await send(`/api/v1/spaces/${space.id}`, { method: "PATCH", cookies: adminCookies, json: { name: "Taken" } });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("name_taken");
  });

  it("returns 403 for the admin's own personal space and 404 for another user's", async () => {
    const own = await send(`/api/v1/spaces/${(await personalSpaceOf(admin)).id}`, {
      method: "PATCH",
      cookies: adminCookies,
      json: { name: "Mine" },
    });
    expect(own.status).toBe(403);
    expect(await errorCode(own)).toBe("forbidden");

    const other = await send(`/api/v1/spaces/${(await personalSpaceOf(member)).id}`, {
      method: "PATCH",
      cookies: adminCookies,
      json: { name: "Mine" },
    });
    expect(other.status).toBe(404);
    expect(await errorCode(other)).toBe("not_found");
    expect((await send("/api/v1/spaces/nope", { method: "PATCH", cookies: adminCookies, json: { name: "X" } })).status).toBe(404);
  });

  it("returns 403 to members and 400 for an invalid name", async () => {
    const space = await insertSpace("everyone", "Everyone");
    const asMember = await send(`/api/v1/spaces/${space.id}`, { method: "PATCH", cookies: memberCookies, json: { name: "X" } });
    expect(asMember.status).toBe(403);
    const invalid = await send(`/api/v1/spaces/${space.id}`, { method: "PATCH", cookies: adminCookies, json: { name: " " } });
    expect(invalid.status).toBe(400);
    expect(await errorCode(invalid)).toBe("invalid_name");
  });
});

describe("DELETE /api/v1/spaces/:id", () => {
  function deleteSpace(id: string, cookies: SessionCookies): Promise<Response> {
    return send(`/api/v1/spaces/${id}`, { method: "DELETE", cookies });
  }

  it("deletes an empty space", async () => {
    const space = await insertSpace("admin", "Empty");
    const kept = await insertSpace("everyone", "Kept");
    const res = await deleteSpace(space.id, adminCookies);
    expect(res.status).toBe(204);
    expect(await db.query.spaces.findFirst({ where: eq(spaces.id, space.id) })).toBeUndefined();
    expect(await db.query.spaces.findFirst({ where: eq(spaces.id, kept.id) })).toEqual(kept);
    expect((await deleteSpace(space.id, adminCookies)).status).toBe(404);
  });

  it("returns 409 space_not_empty and keeps the space and its pages", async () => {
    const space = await insertSpace("everyone", "Full");
    const page = await insertPage({ spaceId: space.id });
    const res = await deleteSpace(space.id, adminCookies);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("space_not_empty");
    expect(await db.query.spaces.findFirst({ where: eq(spaces.id, space.id) })).toEqual(space);
    expect(await countPages()).toBe(1);

    // A page in the trash still keeps the space.
    expect((await send(`/api/v1/pages/${page.id}`, { method: "DELETE", cookies: adminCookies })).status).toBe(204);
    const trashed = await deleteSpace(space.id, adminCookies);
    expect(trashed.status).toBe(409);
    expect(await errorCode(trashed)).toBe("space_not_empty");
    expect(await countPages()).toBe(1);

    expect(
      (await send(`/api/v1/pages/${page.id}/permanent`, { method: "DELETE", cookies: adminCookies })).status,
    ).toBe(204);
    expect((await deleteSpace(space.id, adminCookies)).status).toBe(204);
  });

  it("returns 409 space_not_empty for a space with only folders and keeps them", async () => {
    const space = await insertSpace("everyone", "Folders only");
    const folder = await insertFolder({ spaceId: space.id });
    const res = await deleteSpace(space.id, adminCookies);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: "space_not_empty",
        message: "ページ（ゴミ箱のページを含む）かフォルダが残っているスペースは削除できません。中身を移すか削除してから消してください",
      },
    });
    expect(await db.query.spaces.findFirst({ where: eq(spaces.id, space.id) })).toEqual(space);
    expect(await countFolders()).toBe(1);

    expect((await send(`/api/v1/folders/${folder.id}`, { method: "DELETE", cookies: adminCookies })).status).toBe(204);
    expect((await deleteSpace(space.id, adminCookies)).status).toBe(204);
  });

  it("returns 403 for the admin's own personal space and 404 for another user's", async () => {
    const own = await personalSpaceOf(admin);
    const ownRes = await deleteSpace(own.id, adminCookies);
    expect(ownRes.status).toBe(403);
    expect(await errorCode(ownRes)).toBe("forbidden");

    const otherRes = await deleteSpace((await personalSpaceOf(member)).id, adminCookies);
    expect(otherRes.status).toBe(404);
    expect(await errorCode(otherRes)).toBe("not_found");
    expect(await countSpaces()).toBe(2);
  });

  it("returns 403 to members and 404 for an unknown id", async () => {
    const space = await insertSpace("everyone", "Everyone");
    const asMember = await deleteSpace(space.id, memberCookies);
    expect(asMember.status).toBe(403);
    expect(await errorCode(asMember)).toBe("forbidden");
    expect(await db.query.spaces.findFirst({ where: eq(spaces.id, space.id) })).toEqual(space);

    const unknown = await deleteSpace("nope", adminCookies);
    expect(unknown.status).toBe(404);
    expect(await errorCode(unknown)).toBe("not_found");
  });
});

describe("personal space backfill at login", () => {
  it("creates a missing personal space on password login only once", async () => {
    const legacy = await createUserWithoutSpace({ email: "legacy@example.com" });
    expect(await countPersonalSpaces(legacy.id)).toBe(0);
    await login(legacy.email);
    expect(await countPersonalSpaces(legacy.id)).toBe(1);
    await login(legacy.email);
    expect(await countPersonalSpaces(legacy.id)).toBe(1);
  });

  it("creates a missing personal space on POST /auth/refresh", async () => {
    const legacy = await createUserWithoutSpace({ email: "legacy@example.com" });
    const session = await core.issueSession(appDb, legacy.id, "password", T0);
    const cookies = { "__Host-libreno_rt": session.refreshToken };

    const res = await send("/auth/refresh", { method: "POST", cookies });
    expect(res.status).toBe(204);
    expect(await countPersonalSpaces(legacy.id)).toBe(1);
  });

  it("creates a missing personal space on GET /auth/login with a refresh cookie", async () => {
    const legacy = await createUserWithoutSpace({ email: "legacy@example.com" });
    const session = await core.issueSession(appDb, legacy.id, "password", T0);
    const cookies = { "__Host-libreno_rt": session.refreshToken };

    const res = await send("/auth/login?next=/", { cookies });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
    sessionCookies(res);
    expect(await countPersonalSpaces(legacy.id)).toBe(1);
  });
});

describe("insertPersonalSpaceStatement", () => {
  it("inserts nothing for an unknown user", async () => {
    await insertPersonalSpaceStatement(env.DB, "nope", T0).run();
    expect(await countSpaces()).toBe(2);
  });

  it("reports a UNIQUE violation inside a D1 batch through isUniqueViolation", async () => {
    const error = await env.DB.batch([
      env.DB.prepare("INSERT INTO spaces (id, kind, name, owner_user_id, created_at, updated_at) VALUES (?, 'everyone', 'Dup', NULL, 0, 0)").bind(crypto.randomUUID()),
      env.DB.prepare("INSERT INTO spaces (id, kind, name, owner_user_id, created_at, updated_at) VALUES (?, 'everyone', 'Dup', NULL, 0, 0)").bind(crypto.randomUUID()),
    ]).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isUniqueViolation(error)).toBe(true);
    // The whole batch is rolled back.
    expect(await countSpaces()).toBe(2);
  });
});

describe("migration 0001_spaces backfill", () => {
  function backfillStatement(): string {
    const migration = env.TEST_MIGRATIONS.find((m) => m.name === "0001_spaces.sql");
    if (!migration) throw new Error("migration 0001_spaces.sql not found");
    const inserts = migration.queries
      .map((q) =>
        q
          .split("\n")
          .filter((line) => !line.trimStart().startsWith("--"))
          .join("\n")
          .trim(),
      )
      .filter((q) => q.startsWith("INSERT INTO spaces"));
    if (inserts.length !== 1) throw new Error(`expected one backfill statement, found ${inserts.length}`);
    return inserts[0] ?? "";
  }

  it("creates one personal space for each user without one", async () => {
    const statement = backfillStatement();
    const first = await createUserWithoutSpace({ email: "first@example.com", createdAt: 111 });
    const second = await createUserWithoutSpace({ email: "second@example.com", createdAt: 222 });
    const existing = await personalSpaceOf(member);

    await env.DB.prepare(statement).run();
    for (const user of [first, second]) {
      const rows = await db.select().from(spaces).where(eq(spaces.ownerUserId, user.id)).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toMatch(UUID_V4);
      expect(rows[0]).toMatchObject({ kind: "personal", name: null, createdAt: user.createdAt, updatedAt: user.createdAt });
    }
    expect(await personalSpaceOf(member)).toEqual(existing);
    expect(await countSpaces()).toBe(4);

    await env.DB.prepare(statement).run();
    expect(await countSpaces()).toBe(4);
    const all = await db.select().from(users).orderBy(asc(users.createdAt)).all();
    for (const user of all) expect(await countPersonalSpaces(user.id)).toBe(1);
  });
});
