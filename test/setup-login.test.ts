import { beforeEach, describe, expect, it } from "vitest";
import { countPersonalSpaces, countSpaces, db, PASSWORD, resetDb, send, sessionCookies } from "./helpers";

beforeEach(resetDb);

const setupForm = {
  email: "Admin@Example.com",
  name: "Admin",
  password: PASSWORD,
  password_confirm: PASSWORD,
};

describe("initial setup", () => {
  it("creates the first admin and signs in", async () => {
    expect((await send("/auth/setup")).status).toBe(200);
    const res = await send("/auth/setup", { form: setupForm });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/");
    sessionCookies(res);

    const all = await db.query.users.findMany();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ email: "admin@example.com", name: "Admin", role: "admin" });
    expect(all[0]?.lastLoginAt).not.toBeNull();
    expect(await countPersonalSpaces(all[0]?.id ?? "")).toBe(1);
    expect(await countSpaces()).toBe(1);
  });

  it("creates only one admin and one personal space for concurrent requests", async () => {
    const results = await Promise.all([
      send("/auth/setup", { form: setupForm }),
      send("/auth/setup", { form: { ...setupForm, email: "second@example.com" } }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses[0]).toBe(303);
    expect([404, 409]).toContain(statuses[1]);
    const admins = await db.query.users.findMany();
    expect(admins).toHaveLength(1);
    expect(admins[0]?.role).toBe("admin");
    expect(await countPersonalSpaces(admins[0]?.id ?? "")).toBe(1);
    expect(await countSpaces()).toBe(1);
  });
});

describe("middleware", () => {
  it("sets security headers on pages and API", async () => {
    const page = await send("/auth/login");
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    expect(page.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
    expect(page.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const api = await send("/api/v1/me");
    expect(api.status).toBe(401);
    expect(api.headers.get("Cache-Control")).toBe("no-store");
  });

  // Hono before 4.13.16 skipped wildcard middleware for paths with an encoded line terminator (GHSA-h7mg-cq63-vhpq).
  it("runs the wildcard middleware for paths with an encoded line terminator", async () => {
    for (const terminator of ["%0A", "%0D", "%E2%80%A8", "%E2%80%A9"]) {
      const page = await send(`/auth/missing${terminator}`);
      expect(page.status).toBe(404);
      expect(page.headers.get("Cache-Control")).toBe("no-store");
      expect(page.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
      expect(page.headers.get("X-Content-Type-Options")).toBe("nosniff");
      const api = await send(`/api/v1/missing${terminator}`);
      expect(api.status).toBe(404);
      expect(api.headers.get("Cache-Control")).toBe("no-store");
      const crossSite = await send(`/api/v1/missing${terminator}`, { method: "POST", origin: "https://evil.example" });
      expect(crossSite.status).toBe(403);
    }
  });
});

describe("home", () => {
  // The static assets serve / (the SPA) in front of the Worker, so the Worker has no route for it.
  it("returns 404 for / in the Worker", async () => {
    expect((await send("/")).status).toBe(404);
  });
});
