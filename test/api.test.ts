import { beforeEach, describe, expect, it } from "vitest";
import { countPersonalSpaces, countSpaces, createUser, login, resetDb, send, type SessionCookies } from "./helpers";

const NEW_PASSWORD = "another long passphrase";

let adminCookies: SessionCookies;

beforeEach(async () => {
  await resetDb();
  const admin = await createUser({ email: "admin@example.com", role: "admin", createdAt: 1000 });
  await createUser({ email: "member@example.com", role: "member", createdAt: 2000 });
  adminCookies = await login(admin.email);
});

// The personal space of users created with the admin user API (the userCreatedStatements hook of src/core.ts).
describe("admin user API", () => {
  it("POST /api/v1/users creates exactly one personal space", async () => {
    const res = await send("/api/v1/users", {
      cookies: adminCookies,
      json: { email: "new@example.com", password: NEW_PASSWORD, role: "member" },
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    // Checked before any login, which would also create a missing personal space.
    expect(await countPersonalSpaces(id)).toBe(1);
    expect(await countSpaces()).toBe(3);
  });

  it("returns 409 email_taken for duplicate emails", async () => {
    const res = await send("/api/v1/users", {
      cookies: adminCookies,
      json: { email: "MEMBER@example.com", password: NEW_PASSWORD, role: "member" },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("email_taken");
    // The personal space is rolled back with the user in the same batch.
    expect(await countSpaces()).toBe(2);
  });
});
