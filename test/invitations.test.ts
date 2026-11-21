import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { CreateUserResponse } from "../src/api/types";
import { spaces, users } from "../src/db/schema";
import { countPersonalSpaces, createUser, db, login, resetDb, send, type SessionCookies } from "./helpers";

let adminCookies: SessionCookies;

beforeEach(async () => {
  await resetDb();
  const admin = await createUser({ email: "admin@example.com", role: "admin" });
  adminCookies = await login(admin.email);
});

async function invite(email: string): Promise<CreateUserResponse> {
  const res = await send("/api/v1/users", { cookies: adminCookies, json: { email, role: "member" } });
  expect(res.status).toBe(201);
  return (await res.json()) as CreateUserResponse;
}

describe("invitations in password mode", () => {
  it("creates an invited user with a personal space and returns an invitation link", async () => {
    const created = await invite("bob@example.com");
    expect(created).toMatchObject({ email: "bob@example.com", role: "member", status: "invited" });
    expect(created.invitation?.url).toContain("/auth/invite?token=");
    expect(created.invitation?.expires_at).toBeGreaterThan(Date.now());
    expect(await countPersonalSpaces(created.id)).toBe(1);
  });

  it("deletes an invited user with their personal space", async () => {
    const created = await invite("bob@example.com");
    const res = await send(`/api/v1/users/${created.id}`, { method: "DELETE", cookies: adminCookies });
    expect(res.status).toBe(204);
    expect(await db.query.users.findFirst({ where: eq(users.id, created.id) })).toBeUndefined();
    expect(await db.query.spaces.findFirst({ where: eq(spaces.ownerUserId, created.id) })).toBeUndefined();
  });
});
