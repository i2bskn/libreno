import { eq } from "drizzle-orm";
import { base64UrlEncode } from "@i2bskn/workers-app-core";
import { beforeEach, describe, expect, it } from "vitest";
import { users } from "../src/db/schema";
import {
  db,
  ORIGIN,
  PASSWORD,
  resetDb,
  send,
  sessionCookies,
  setCookies,
  type SessionCookies,
} from "./helpers";

// The login, user management and MCP OAuth of @i2bskn/workers-app-core, as wired into libreno (src/core.ts). The
// package tests cover their behavior in detail.

const REDIRECT_URI = "https://client.example/cb";
const MCP_ACCEPT = "application/json, text/event-stream";
const NEW_PASSWORD = "a brand new password";

async function setup(): Promise<SessionCookies> {
  const res = await send("/auth/setup", {
    form: { email: "admin@example.com", name: "Admin", password: PASSWORD, password_confirm: PASSWORD },
  });
  expect(res.status).toBe(303);
  return sessionCookies(res);
}

async function openConsent(cookies: SessionCookies) {
  const registered = await send("/oauth/register", {
    json: { redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none", client_name: "Test client" },
  });
  expect(registered.status).toBe(201);
  const { client_id: clientId } = (await registered.json()) as { client_id: string };
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "mcp",
    state: "state-123",
    code_challenge: base64UrlEncode(new Uint8Array(digest)),
    code_challenge_method: "S256",
    resource: `${ORIGIN}/mcp`,
  });
  const res = await send(`/authorize?${params}`, { cookies });
  expect(res.status).toBe(200);
  const html = await res.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const consentCookies: Record<string, string> = { ...cookies };
  for (const [name, cookie] of Object.entries(setCookies(res))) consentCookies[name] = cookie.value;
  return { html, handle, cookies: consentCookies, clientId, verifier };
}

// Runs the OAuth flow and returns an MCP access token.
async function authorize(cookies: SessionCookies): Promise<string> {
  const consent = await openConsent(cookies);
  const approved = await send("/authorize", {
    cookies: consent.cookies,
    form: { handle: consent.handle, decision: "approve" },
  });
  expect(approved.status).toBe(302);
  const code = new URL(approved.headers.get("Location") ?? "").searchParams.get("code") ?? "";
  const token = await send("/oauth/token", {
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: consent.clientId,
      code_verifier: consent.verifier,
    },
  });
  expect(token.status).toBe(200);
  return ((await token.json()) as { access_token: string }).access_token;
}

function listTools(token: string): Promise<Response> {
  return send("/mcp", {
    headers: { Authorization: `Bearer ${token}`, Accept: MCP_ACCEPT },
    json: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
}

beforeEach(resetDb);

describe("core", () => {
  it("creates the first admin, signs in and serves /api/v1/me and /api/v1/users", async () => {
    const cookies = await setup();
    expect(Object.keys(cookies).sort()).toEqual(["__Host-libreno_at", "__Host-libreno_rt"]);

    const me = await send("/api/v1/me", { cookies });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: "admin@example.com", name: "Admin", role: "admin" });

    const created = await send("/api/v1/users", {
      cookies,
      json: { email: "member@example.com", password: "a long enough password", role: "member" },
    });
    expect(created.status).toBe(201);
    const list = await send("/api/v1/users", { cookies });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      users: [{ email: "admin@example.com" }, { email: "member@example.com" }],
      auth_mode: "password",
    });

    const login = await send("/auth/login", {
      form: { email: "member@example.com", password: "a long enough password", next: "/" },
    });
    expect(login.status).toBe(303);
    const member = await send("/api/v1/users", { cookies: sessionCookies(login) });
    expect(member.status).toBe(403);
  });

  it("uses the libreno layout on the login page", async () => {
    await setup();
    const res = await send("/auth/login");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>ログイン - libreno</title>");
    expect(html).toContain('<script src="/server-pages.js" defer="">');
    expect(html).toContain("チームの情報を、AIと一緒に育てる場所。");
  });

  it("shows the libreno consent page", async () => {
    const consent = await openConsent(await setup());
    expect(consent.html).toContain("<title>接続の許可 - libreno</title>");
    expect(consent.html).toContain(
      "許可すると、このアプリはあなたとして、あなたがアクセスできるスペースのページを読み書きできるようになります。",
    );
    expect(consent.html).toMatch(/<form [^>]*action="\/authorize"[^>]*data-single-submit/);
  });

  it("lists the tools at /mcp with an authorized grant", async () => {
    const token = await authorize(await setup());
    const res = await listTools(token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((tool) => tool.name)).toContain("list_spaces");
  });
});

describe("mcp_revoked_at", () => {
  it("rejects an MCP token authorized before the user changed the password", async () => {
    const cookies = await setup();
    const token = await authorize(cookies);
    expect((await listTools(token)).status).toBe(200);

    const res = await send("/api/v1/me/password", {
      cookies,
      json: { current_password: PASSWORD, new_password: NEW_PASSWORD },
    });
    expect(res.status).toBe(204);

    expect((await listTools(token)).status).toBe(401);
    const admin = await db.query.users.findFirst({ where: eq(users.email, "admin@example.com") });
    expect(admin?.mcpRevokedAt).not.toBeNull();
  });

  it("rejects the token even when the grant is still in KV", async () => {
    const cookies = await setup();
    const token = await authorize(cookies);

    // A plain http host cannot serve OAuth, so the grants in KV are not revoked there.
    const res = await send("http://wiki.example.com/api/v1/me/password", {
      cookies,
      json: { current_password: PASSWORD, new_password: NEW_PASSWORD },
    });
    expect(res.status).toBe(204);

    expect((await listTools(token)).status).toBe(401);
  });
});
