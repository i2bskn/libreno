import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { base64UrlEncode } from "@i2bskn/workers-app-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Attachment,
  AttachmentList,
  Folder,
  FolderList,
  Page,
  PageList,
  PageRevision,
  PageRevisionList,
  PageSummary,
  SearchResult,
  Space,
  SpaceList,
  TrashList,
} from "../src/api/types";
import {
  folders,
  pageRevisions,
  pages,
  spaceMembers,
  spaces,
  users,
  type FolderRow,
  type PageRow,
  type SpaceRow,
  type UserRow,
} from "../src/db/schema";
import type { Bindings } from "../src/env";
import {
  countFolders,
  countPages,
  createUser,
  db,
  insertFolder,
  insertPage,
  login,
  OIDC_ORIGIN,
  oidcEnv,
  ORIGIN,
  resetAttachments,
  resetDb,
  send,
  setCookies,
  type RequestOptions,
} from "./helpers";

const REDIRECT_URI = "https://client.example/cb";
const MCP_ACCEPT = "application/json, text/event-stream";

type Cookies = Record<string, string>;

type FlowOptions = {
  origin?: string;
  env?: Partial<Bindings>;
  sharedEnv?: Cloudflare.Env;
  redirectUri?: string;
  clientName?: string;
};

type TokenResponse = { access_token: string; refresh_token?: string; resource?: string; expires_in: number };

function withDefaults(options: FlowOptions): RequestOptions {
  return { env: options.env, sharedEnv: options.sharedEnv };
}

async function registerClient(options: FlowOptions = {}): Promise<string> {
  const origin = options.origin ?? ORIGIN;
  const res = await send(`${origin}/oauth/register`, {
    ...withDefaults(options),
    json: {
      redirect_uris: [options.redirectUri ?? REDIRECT_URI],
      token_endpoint_auth_method: "none",
      client_name: options.clientName ?? "Test client",
    },
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { client_id: string };
  return body.client_id;
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

function authorizeUrl(origin: string, clientId: string, challenge: string, redirectUri = REDIRECT_URI): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "mcp",
    state: "state-123",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${origin}/mcp`,
  });
  return `${origin}/authorize?${params}`;
}

type Consent = { html: string; handle: string; cookies: Cookies };

async function openConsent(
  sessionCookies: Cookies,
  options: FlowOptions = {},
): Promise<Consent & { clientId: string; verifier: string }> {
  const origin = options.origin ?? ORIGIN;
  const clientId = await registerClient(options);
  const { verifier, challenge } = await pkce();
  const res = await send(authorizeUrl(origin, clientId, challenge, options.redirectUri), {
    ...withDefaults(options),
    cookies: sessionCookies,
  });
  expect(res.status).toBe(200);
  const html = await res.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  if (!handle) throw new Error(`handle not found: ${html}`);
  const cookies: Cookies = { ...sessionCookies };
  for (const [name, cookie] of Object.entries(setCookies(res))) cookies[name] = cookie.value;
  return { html, handle, cookies, clientId, verifier };
}

// Runs DCR, PKCE, the consent page and the token request, and returns the token response.
async function authorizeClient(sessionCookies: Cookies, options: FlowOptions = {}): Promise<TokenResponse> {
  const origin = options.origin ?? ORIGIN;
  const consent = await openConsent(sessionCookies, options);
  const approved = await send(`${origin}/authorize`, {
    ...withDefaults(options),
    cookies: consent.cookies,
    form: { handle: consent.handle, decision: "approve" },
  });
  expect(approved.status).toBe(302);
  const location = new URL(approved.headers.get("Location") ?? "");
  const code = location.searchParams.get("code");
  if (!code) throw new Error(`code not found: ${location.href}`);

  const res = await send(`${origin}/oauth/token`, {
    ...withDefaults(options),
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: options.redirectUri ?? REDIRECT_URI,
      client_id: consent.clientId,
      code_verifier: consent.verifier,
    },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as TokenResponse;
}

async function mcpRequest(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  options: { origin?: string; env?: Partial<Bindings>; sharedEnv?: Cloudflare.Env } = {},
): Promise<Response> {
  return send(`${options.origin ?? ORIGIN}/mcp`, {
    env: options.env,
    sharedEnv: options.sharedEnv,
    headers: { Authorization: `Bearer ${token}`, Accept: MCP_ACCEPT },
    json: { jsonrpc: "2.0", id: 1, method, params },
  });
}

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean; structuredContent?: unknown };

async function callTool(token: string, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const res = await mcpRequest(token, "tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: ToolResult; error?: unknown };
  if (!body.result) throw new Error(`no result: ${JSON.stringify(body)}`);
  return body.result;
}

function toolJson<T>(result: ToolResult): T {
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toBeUndefined();
  return JSON.parse(result.content[0]?.text ?? "") as T;
}

function expectToolError(result: ToolResult, message: string) {
  expect(result.isError).toBe(true);
  expect(result.content).toEqual([{ type: "text", text: message }]);
}

async function insertSpace(kind: "everyone" | "admin" | "members", name: string): Promise<SpaceRow> {
  const now = Date.now();
  const [space] = await db
    .insert(spaces)
    .values({ id: crypto.randomUUID(), kind, name, createdAt: now, updatedAt: now })
    .returning();
  if (!space) throw new Error("failed to create space");
  return space;
}

async function personalSpaceOf(user: UserRow): Promise<SpaceRow> {
  const space = await db.query.spaces.findFirst({ where: eq(spaces.ownerUserId, user.id) });
  if (!space) throw new Error("personal space not found");
  return space;
}

let admin: UserRow;
let member: UserRow;
let adminCookies: Cookies;
let memberCookies: Cookies;

beforeEach(async () => {
  await resetDb();
  admin = await createUser({ email: "admin@example.com", role: "admin" });
  member = await createUser({ email: "member@example.com" });
  adminCookies = await login(admin.email);
  memberCookies = await login(member.email);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /authorize", () => {
  it("shows the client, the redirect host and the user, escaped and not frameable", async () => {
    const consent = await openConsent(memberCookies, { clientName: "<script>alert(1)</script>" });
    expect(consent.html).not.toContain("<script>alert(1)</script>");
    expect(consent.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(consent.html).toContain("このアプリの名前は確認されていません");
    expect(consent.html).toContain("client.example");
    expect(consent.html).toContain(member.email);
    expect(consent.html).not.toContain("このパソコン上のアプリ");
    // A second click on 許可する would be rejected, because the first POST uses up the transaction.
    expect(consent.html).toContain('<script src="/server-pages.js" defer="">');
    expect(consent.html).toMatch(/<form [^>]*action="\/authorize"[^>]*data-single-submit/);
    const res = await send(authorizeUrl(ORIGIN, consent.clientId, (await pkce()).challenge), {
      cookies: memberCookies,
    });
    expect(res.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("warns when the redirect goes to a loopback address", async () => {
    const consent = await openConsent(memberCookies, { redirectUri: "http://127.0.0.1:33418/callback" });
    expect(consent.html).toContain("127.0.0.1");
    expect(consent.html).toContain("このパソコン上のアプリに接続を渡します");
  });
});

describe("POST /authorize", () => {
  it("rejects a cross-site form post", async () => {
    const consent = await openConsent(memberCookies);
    const res = await send("/authorize", {
      cookies: consent.cookies,
      form: { handle: consent.handle, decision: "approve" },
      origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
  });
});

describe("MCP", () => {
  it("initializes and lists the twenty tools with their annotations", async () => {
    const { access_token } = await authorizeClient(memberCookies);
    const init = await mcpRequest(access_token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });
    expect(init.status).toBe(200);
    const initBody = (await init.json()) as { result: { serverInfo: { name: string } } };
    expect(initBody.result.serverInfo.name).toBe("libreno");

    const list = await mcpRequest(access_token, "tools/list");
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      result: { tools: { name: string; outputSchema?: unknown; annotations?: unknown }[] };
    };
    expect(listBody.result.tools.map((t) => t.name).sort()).toEqual([
      "create_folder",
      "create_page",
      "delete_folder",
      "delete_page",
      "get_page",
      "get_page_revision",
      "list_attachments",
      "list_folders",
      "list_page_revisions",
      "list_pages",
      "list_spaces",
      "list_trash",
      "move_folder",
      "move_page",
      "restore_page",
      "restore_page_revision",
      "search_pages",
      "update_folder",
      "update_page",
      "upload_attachment",
    ]);
    expect(listBody.result.tools.every((t) => t.outputSchema === undefined)).toBe(true);
    const annotations = Object.fromEntries(listBody.result.tools.map((t) => [t.name, t.annotations]));
    const readOnly = { readOnlyHint: true, openWorldHint: false };
    expect(annotations).toEqual({
      list_spaces: readOnly,
      list_pages: readOnly,
      get_page: readOnly,
      search_pages: readOnly,
      create_page: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      update_page: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      list_folders: readOnly,
      create_folder: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      update_folder: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      delete_folder: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      list_page_revisions: readOnly,
      get_page_revision: readOnly,
      restore_page_revision: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      delete_page: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      list_trash: readOnly,
      restore_page: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      move_page: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      move_folder: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      upload_attachment: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      list_attachments: readOnly,
    });
  });

  it("returns the same spaces as the REST API for a member and an admin", async () => {
    await insertSpace("everyone", "Everyone");
    await insertSpace("admin", "Admins");
    const later = await insertSpace("everyone", "Later");
    // The space created last comes first, and the personal space stays last.
    await db.update(spaces).set({ sortOrder: -1 }).where(eq(spaces.id, later.id));
    for (const cookies of [memberCookies, adminCookies]) {
      const { access_token } = await authorizeClient(cookies);
      const rest = (await (await send("/api/v1/spaces", { cookies })).json()) as SpaceList;
      const result = toolJson<SpaceList>(await callTool(access_token, "list_spaces"));
      expect(result).toEqual(rest);
      expect(result.spaces[0]?.id).toBe(later.id);
      expect(result.spaces.at(-1)?.kind).toBe("personal");
    }
  });

  it("does not show admin spaces to a member", async () => {
    const adminSpace = await insertSpace("admin", "Admins");
    const { access_token } = await authorizeClient(memberCookies);
    const result = toolJson<SpaceList>(await callTool(access_token, "list_spaces"));
    expect(result.spaces.map((s: Space) => s.id)).not.toContain(adminSpace.id);
    expect(result.spaces.map((s: Space) => s.kind).sort()).toEqual(["personal"]);
  });

  it("lists and reads pages only in accessible spaces", async () => {
    const everyone = await insertSpace("everyone", "Everyone");
    const adminSpace = await insertSpace("admin", "Admins");
    const visible = await insertPage({ spaceId: everyone.id, title: "Visible", body: "# Hello" });
    const adminPage = await insertPage({ spaceId: adminSpace.id, title: "Secret" });
    const othersPage = await insertPage({ spaceId: (await personalSpaceOf(admin)).id, title: "Admin's own" });
    const ownPage = await insertPage({ spaceId: (await personalSpaceOf(member)).id, title: "Mine" });
    const { access_token } = await authorizeClient(memberCookies);

    const pageList = toolJson<PageList>(await callTool(access_token, "list_pages", { space_id: everyone.id }));
    expect(pageList.pages.map((p) => p.id)).toEqual([visible.id]);
    expect(pageList.pages[0]).not.toHaveProperty("body");
    const page = toolJson<Page>(await callTool(access_token, "get_page", { page_id: visible.id }));
    expect(page).toMatchObject({ id: visible.id, title: "Visible", body: "# Hello", version: 1 });
    expect(toolJson<Page>(await callTool(access_token, "get_page", { page_id: ownPage.id })).id).toBe(ownPage.id);

    expectToolError(await callTool(access_token, "list_pages", { space_id: adminSpace.id }), "スペースが見つかりません");
    expectToolError(
      await callTool(access_token, "list_pages", { space_id: (await personalSpaceOf(admin)).id }),
      "スペースが見つかりません",
    );
    expectToolError(await callTool(access_token, "list_pages", { space_id: "missing" }), "スペースが見つかりません");
    expectToolError(await callTool(access_token, "get_page", { page_id: adminPage.id }), "ページが見つかりません");
    expectToolError(await callTool(access_token, "get_page", { page_id: othersPage.id }), "ページが見つかりません");
    expectToolError(await callTool(access_token, "get_page", { page_id: "missing" }), "ページが見つかりません");
  });

  it("hides admin spaces as soon as the user is no longer an admin", async () => {
    const adminSpace = await insertSpace("admin", "Admins");
    const { access_token } = await authorizeClient(adminCookies);
    const before = toolJson<SpaceList>(await callTool(access_token, "list_spaces"));
    expect(before.spaces.map((s) => s.id)).toContain(adminSpace.id);

    await db.update(users).set({ role: "member" }).where(eq(users.id, admin.id));
    const after = toolJson<SpaceList>(await callTool(access_token, "list_spaces"));
    expect(after.spaces.map((s) => s.id)).not.toContain(adminSpace.id);
  });

  it("hides a members space and its pages as soon as the user is removed from the members", async () => {
    const team = await insertSpace("members", "Team");
    await db.insert(spaceMembers).values({ spaceId: team.id, userId: member.id, createdAt: Date.now() });
    const page = await insertPage({ spaceId: team.id, title: "Team notes", body: "the plan" });
    const { access_token } = await authorizeClient(memberCookies);
    const listIds = async () =>
      toolJson<SpaceList>(await callTool(access_token, "list_spaces")).spaces.map((s) => s.id);
    const searchIds = async () =>
      toolJson<SearchResult>(await callTool(access_token, "search_pages", { query: "plan" })).hits.map((h) => h.id);

    expect(await listIds()).toContain(team.id);
    expect(toolJson<Page>(await callTool(access_token, "get_page", { page_id: page.id })).id).toBe(page.id);
    expect(await searchIds()).toEqual([page.id]);

    await db.delete(spaceMembers).where(eq(spaceMembers.spaceId, team.id));
    expect(await listIds()).not.toContain(team.id);
    expectToolError(await callTool(access_token, "get_page", { page_id: page.id }), "ページが見つかりません");
    expect(await searchIds()).toEqual([]);
  });

  it("returns 401 once the user is deleted", async () => {
    const { access_token } = await authorizeClient(memberCookies);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(member.id),
      env.DB.prepare("DELETE FROM spaces WHERE owner_user_id = ?").bind(member.id),
      env.DB.prepare("DELETE FROM users WHERE id = ?").bind(member.id),
    ]);
    const res = await mcpRequest(access_token, "tools/list");
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
    expect(res.headers.get("WWW-Authenticate")).toBe(
      `Bearer error="invalid_token", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it("reports unexpected errors in tools with a fixed message", async () => {
    const everyone = await insertSpace("everyone", "Everyone");
    const page = await insertPage({ spaceId: everyone.id });
    const { access_token } = await authorizeClient(memberCookies);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    await env.DB.exec("ALTER TABLE pages RENAME TO pages_unavailable");
    let result: ToolResult;
    try {
      result = await callTool(access_token, "get_page", { page_id: page.id });
    } finally {
      await env.DB.exec("ALTER TABLE pages_unavailable RENAME TO pages");
    }
    expectToolError(result, "サーバーでエラーが発生しました");
    expect(JSON.stringify(result)).not.toContain("pages");
    expect(errorLog).toHaveBeenCalledWith("mcp tool failed", expect.objectContaining({ tool: "get_page" }));
  });
});

describe("search_pages", () => {
  const invalidQuery = "検索語は 1 文字以上 100 文字以下で、改行などの制御文字を含まない文字列にしてください";

  let token: string;
  let everyone: SpaceRow;

  beforeEach(async () => {
    token = (await authorizeClient(memberCookies)).access_token;
    everyone = await insertSpace("everyone", "Everyone");
  });

  it("returns the same result as the REST API", async () => {
    const page = await insertPage({ spaceId: everyone.id, title: "Notes", body: "how to deploy" });
    const result = toolJson<SearchResult>(await callTool(token, "search_pages", { query: "deploy" }));
    expect(result.hits.map((hit) => hit.id)).toEqual([page.id]);
    expect(result.hits[0]?.snippet).toBe("how to deploy");
    expect(result.hits[0]).not.toHaveProperty("body");
    expect(result.has_more).toBe(false);
    const rest = (await (await send("/api/v1/search?q=deploy", { cookies: memberCookies })).json()) as SearchResult;
    expect(result).toEqual(rest);
  });

  it("does not return pages the user cannot access, even when only the body matches", async () => {
    const adminSpace = await insertSpace("admin", "Admins");
    await insertPage({ spaceId: adminSpace.id, title: "notes", body: "the secret is here" });
    await insertPage({ spaceId: (await personalSpaceOf(admin)).id, title: "notes", body: "the secret is here" });
    const visible = await insertPage({ spaceId: everyone.id, title: "notes", body: "the secret is here" });
    const result = toolJson<SearchResult>(await callTool(token, "search_pages", { query: "secret" }));
    expect(result.hits.map((hit) => hit.id)).toEqual([visible.id]);
  });

  it("searches all spaces when space_id is empty", async () => {
    const other = await insertSpace("everyone", "Other");
    const a = await insertPage({ spaceId: everyone.id, title: "key a", body: "", at: 2 });
    const b = await insertPage({ spaceId: other.id, title: "key b", body: "", at: 1 });
    const all = toolJson<SearchResult>(await callTool(token, "search_pages", { query: "key", space_id: "" }));
    expect(all.hits.map((hit) => hit.id)).toEqual([a.id, b.id]);
    const one = toolJson<SearchResult>(await callTool(token, "search_pages", { query: "key", space_id: other.id }));
    expect(one.hits.map((hit) => hit.id)).toEqual([b.id]);
  });

  it("reports an invalid query", async () => {
    expectToolError(await callTool(token, "search_pages", { query: "  " }), invalidQuery);
    expectToolError(await callTool(token, "search_pages", { query: "a".repeat(101) }), invalidQuery);
    expectToolError(await callTool(token, "search_pages", { query: "a\nb", space_id: "missing" }), invalidQuery);
  });

  it("reports a space the user cannot access as missing", async () => {
    const adminSpace = await insertSpace("admin", "Admins");
    for (const spaceId of [adminSpace.id, (await personalSpaceOf(admin)).id, "missing"]) {
      expectToolError(
        await callTool(token, "search_pages", { query: "key", space_id: spaceId }),
        "スペースが見つかりません",
      );
    }
  });
});

describe("MCP write tools", () => {
  const BODY_MAX_BYTES = 524_288;
  const invalidTitle = "タイトルは 1 文字以上 200 文字以下で、改行などの制御文字を含まない文字列にしてください";
  const invalidPageBody = "本文は 512KB 以下で、NUL 文字を含まない文字列にしてください";
  const invalidVersion = "version は 1 以上の整数で指定してください";
  const emptyUpdate = "title、body、folder_id のいずれかを指定してください";
  const pageNotFound = "ページが見つかりません";
  const spaceNotFound = "スペースが見つかりません";

  let token: string;

  beforeEach(async () => {
    token = (await authorizeClient(memberCookies)).access_token;
  });

  async function readPage(id: string): Promise<PageRow | undefined> {
    return db.query.pages.findFirst({ where: eq(pages.id, id) });
  }

  describe("create_page", () => {
    it("creates a page in an everyone space and returns it without the body", async () => {
      const everyone = await insertSpace("everyone", "Everyone");
      const result = toolJson<PageSummary>(
        await callTool(token, "create_page", { space_id: everyone.id, title: "  Hello  ", body: "# Hi\n" }),
      );
      expect(result).not.toHaveProperty("body");
      expect(result).toMatchObject({
        space_id: everyone.id,
        title: "Hello",
        version: 1,
        created_by: member.id,
        updated_by: member.id,
      });
      const res = await send(`/api/v1/pages/${result.id}`, { cookies: memberCookies });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ...result, body: "# Hi\n" });
    });

    it("creates a page in the user's personal space", async () => {
      const personal = await personalSpaceOf(member);
      const result = toolJson<PageSummary>(
        await callTool(token, "create_page", { space_id: personal.id, title: "Mine", body: "" }),
      );
      expect(result).toMatchObject({ space_id: personal.id, title: "Mine", version: 1 });
      expect(await countPages()).toBe(1);
    });

    it("reports inaccessible and unknown spaces as missing", async () => {
      const adminSpace = await insertSpace("admin", "Admins");
      for (const spaceId of [adminSpace.id, (await personalSpaceOf(admin)).id, "missing"]) {
        const result = await callTool(token, "create_page", { space_id: spaceId, title: "T", body: "" });
        expectToolError(result, spaceNotFound);
      }
      expect(await countPages()).toBe(0);
    });

    it("rejects an invalid title", async () => {
      const everyone = await insertSpace("everyone", "Everyone");
      expectToolError(
        await callTool(token, "create_page", { space_id: everyone.id, title: "   ", body: "" }),
        invalidTitle,
      );
      expect(await countPages()).toBe(0);
    });

    it("accepts a body of exactly 512KB and rejects one byte more", async () => {
      const everyone = await insertSpace("everyone", "Everyone");
      const tooLong = "a".repeat(BODY_MAX_BYTES - 2) + "あ";
      expect(new TextEncoder().encode(tooLong).byteLength).toBe(BODY_MAX_BYTES + 1);
      expectToolError(
        await callTool(token, "create_page", { space_id: everyone.id, title: "T", body: tooLong }),
        invalidPageBody,
      );
      expect(await countPages()).toBe(0);

      const exact = "a".repeat(BODY_MAX_BYTES - 3) + "あ";
      expect(new TextEncoder().encode(exact).byteLength).toBe(BODY_MAX_BYTES);
      const result = toolJson<PageSummary>(
        await callTool(token, "create_page", { space_id: everyone.id, title: "T", body: exact }),
      );
      expect((await readPage(result.id))?.body).toBe(exact);
    });

    it("reports unexpected errors with a fixed message", async () => {
      const everyone = await insertSpace("everyone", "Everyone");
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      await env.DB.exec("ALTER TABLE pages RENAME TO pages_unavailable");
      let result: ToolResult;
      try {
        result = await callTool(token, "create_page", { space_id: everyone.id, title: "T", body: "" });
      } finally {
        await env.DB.exec("ALTER TABLE pages_unavailable RENAME TO pages");
      }
      expectToolError(result, "サーバーでエラーが発生しました");
      expect(JSON.stringify(result)).not.toContain("pages");
      expect(errorLog).toHaveBeenCalledWith("mcp tool failed", expect.objectContaining({ tool: "create_page" }));
      expect(await countPages()).toBe(0);
    });
  });

  describe("update_page", () => {
    let everyone: SpaceRow;
    let page: PageRow;

    beforeEach(async () => {
      everyone = await insertSpace("everyone", "Everyone");
      page = await insertPage({ spaceId: everyone.id, title: "Title", body: "Body", createdBy: admin.id });
    });

    it("updates only the title and returns the page without the body", async () => {
      const result = toolJson<PageSummary>(
        await callTool(token, "update_page", { page_id: page.id, version: 1, title: "  New  " }),
      );
      expect(result).not.toHaveProperty("body");
      expect(result).toMatchObject({
        id: page.id,
        title: "New",
        version: 2,
        created_by: admin.id,
        updated_by: member.id,
      });
      expect(await readPage(page.id)).toMatchObject({ title: "New", body: "Body", version: 2, updatedBy: member.id });
    });

    it("updates only the body", async () => {
      const result = toolJson<PageSummary>(
        await callTool(token, "update_page", { page_id: page.id, version: 1, body: "New body" }),
      );
      expect(result.version).toBe(2);
      expect(await readPage(page.id)).toMatchObject({ title: "Title", body: "New body", version: 2 });
    });

    it("reports a stale version with guidance and changes nothing", async () => {
      const first = await callTool(token, "update_page", { page_id: page.id, version: 1, body: "first" });
      expect(toolJson<PageSummary>(first).version).toBe(2);
      const before = await readPage(page.id);
      expectToolError(
        await callTool(token, "update_page", { page_id: page.id, version: 1, body: "second" }),
        "ページが他の人に更新されています。最新の内容を取得してからやり直してください。get_page で最新の version と本文を取得し、変更を反映し直してから update_page を呼んでください",
      );
      expect(await readPage(page.id)).toEqual(before);
    });

    it("requires a title or a body", async () => {
      expectToolError(await callTool(token, "update_page", { page_id: page.id, version: 1 }), emptyUpdate);
      expect(await readPage(page.id)).toEqual(page);
    });

    it.each([0, -1, 1.5, 2 ** 53])("rejects version %s", async (version) => {
      expectToolError(await callTool(token, "update_page", { page_id: page.id, version, title: "T" }), invalidVersion);
      expect(await readPage(page.id)).toEqual(page);
    });

    it("checks the version before the empty update", async () => {
      expectToolError(await callTool(token, "update_page", { page_id: page.id, version: 0 }), invalidVersion);
    });

    it("rejects an invalid title", async () => {
      expectToolError(
        await callTool(token, "update_page", { page_id: page.id, version: 1, title: "   " }),
        invalidTitle,
      );
      expect(await readPage(page.id)).toEqual(page);
    });

    it("rejects a body over 512KB", async () => {
      const tooLong = "a".repeat(BODY_MAX_BYTES - 2) + "あ";
      expectToolError(
        await callTool(token, "update_page", { page_id: page.id, version: 1, body: tooLong }),
        invalidPageBody,
      );
      expect(await readPage(page.id)).toEqual(page);
    });

    it("reports pages in inaccessible spaces and unknown pages as missing", async () => {
      const adminSpace = await insertSpace("admin", "Admins");
      const adminPage = await insertPage({ spaceId: adminSpace.id, title: "Secret", body: "Secret" });
      const othersPage = await insertPage({ spaceId: (await personalSpaceOf(admin)).id, title: "Own", body: "Own" });
      for (const target of [adminPage, othersPage]) {
        expectToolError(
          await callTool(token, "update_page", { page_id: target.id, version: 1, body: "changed" }),
          pageNotFound,
        );
        expect(await readPage(target.id)).toEqual(target);
      }
      expectToolError(
        await callTool(token, "update_page", { page_id: "missing", version: 1, body: "x" }),
        pageNotFound,
      );
    });
  });
});

describe("MCP revision tools", () => {
  const pageNotFound = "ページが見つかりません";
  const revisionNotFound = "この版は見つかりません。古い版は新しい 20 版を残して削除されます";
  const invalidVersion = "version は 1 以上の整数で指定してください";

  let token: string;
  let everyone: SpaceRow;
  let page: PageRow;

  beforeEach(async () => {
    token = (await authorizeClient(memberCookies)).access_token;
    everyone = await insertSpace("everyone", "Everyone");
    page = await insertPage({ spaceId: everyone.id, title: "Title 1", body: "Body 1", createdBy: admin.id });
    const updated = await callTool(token, "update_page", { page_id: page.id, version: 1, title: "Title 2", body: "Body 2" });
    expect(toolJson<PageSummary>(updated).version).toBe(2);
  });

  async function readPage(id: string): Promise<PageRow | undefined> {
    return db.query.pages.findFirst({ where: eq(pages.id, id) });
  }

  async function countRevisions(pageId: string): Promise<number> {
    const rows = await db.select().from(pageRevisions).where(eq(pageRevisions.pageId, pageId)).all();
    return rows.length;
  }

  async function inaccessiblePages(): Promise<PageRow[]> {
    const adminSpace = await insertSpace("admin", "Admins");
    const adminPage = await insertPage({ spaceId: adminSpace.id, title: "Secret", body: "Secret" });
    const othersPage = await insertPage({ spaceId: (await personalSpaceOf(admin)).id, title: "Own", body: "Own" });
    const adminToken = (await authorizeClient(adminCookies)).access_token;
    for (const target of [adminPage, othersPage]) {
      const result = await callTool(adminToken, "update_page", { page_id: target.id, version: 1, body: "changed" });
      expect(toolJson<PageSummary>(result).version).toBe(2);
    }
    return [adminPage, othersPage];
  }

  it("describes how to link pages and find the links to a page", async () => {
    const list = await mcpRequest(token, "tools/list");
    const body = (await list.json()) as { result: { tools: { name: string; description: string }[] } };
    const description = (name: string) => body.result.tools.find((t) => t.name === name)?.description ?? "";
    expect(description("get_page")).toContain("[title](/pages/{page_id})");
    expect(description("get_page")).toContain("call search_pages with the query /pages/{page_id}");
    expect(description("create_page")).toContain("Link to other pages with [title](/pages/{page_id}).");
    expect(description("update_page")).toContain("Link to other pages with [title](/pages/{page_id}).");
  });

  it("describes update_page with the revisions", async () => {
    const list = await mcpRequest(token, "tools/list");
    const body = (await list.json()) as { result: { tools: { name: string; description: string }[] } };
    const description = body.result.tools.find((t) => t.name === "update_page")?.description ?? "";
    expect(description).toContain(
      "The previous title and body are kept as a revision (the newest 20 per page); " +
        "use list_page_revisions and restore_page_revision to go back.",
    );
    expect(description).not.toContain("There is no edit history yet");
  });

  describe("list_page_revisions", () => {
    it("returns the same revisions as the REST API", async () => {
      const result = toolJson<PageRevisionList>(await callTool(token, "list_page_revisions", { page_id: page.id }));
      expect(result.revisions).toEqual([
        { version: 1, title: "Title 1", created_by: admin.id, created_at: page.updatedAt },
      ]);
      const res = await send(`/api/v1/pages/${page.id}/revisions`, { cookies: memberCookies });
      expect(await res.json()).toEqual(result);
    });

    it("reports pages in inaccessible spaces and unknown pages as missing", async () => {
      for (const target of await inaccessiblePages()) {
        expectToolError(await callTool(token, "list_page_revisions", { page_id: target.id }), pageNotFound);
      }
      expectToolError(await callTool(token, "list_page_revisions", { page_id: "missing" }), pageNotFound);
    });
  });

  describe("get_page_revision", () => {
    it("returns the revision with its body, like the REST API", async () => {
      const result = toolJson<PageRevision>(
        await callTool(token, "get_page_revision", { page_id: page.id, revision_version: 1 }),
      );
      expect(result).toEqual({
        page_id: page.id,
        version: 1,
        title: "Title 1",
        created_by: admin.id,
        created_at: page.updatedAt,
        body: "Body 1",
      });
      const res = await send(`/api/v1/pages/${page.id}/revisions/1`, { cookies: memberCookies });
      expect(await res.json()).toEqual(result);
    });

    it.each([2, 3, 0, -1, 1.5, 2 ** 53])("reports revision_version %s as missing", async (revision_version) => {
      expectToolError(
        await callTool(token, "get_page_revision", { page_id: page.id, revision_version }),
        revisionNotFound,
      );
    });

    it("does not return a revision of another page", async () => {
      const other = await insertPage({ spaceId: everyone.id, title: "Other", body: "" });
      expectToolError(
        await callTool(token, "get_page_revision", { page_id: other.id, revision_version: 1 }),
        revisionNotFound,
      );
    });

    it("reports pages in inaccessible spaces and unknown pages as missing", async () => {
      for (const target of await inaccessiblePages()) {
        for (const revision_version of [1, 0]) {
          expectToolError(
            await callTool(token, "get_page_revision", { page_id: target.id, revision_version }),
            pageNotFound,
          );
        }
      }
      expectToolError(
        await callTool(token, "get_page_revision", { page_id: "missing", revision_version: 1 }),
        pageNotFound,
      );
    });
  });

  describe("restore_page_revision", () => {
    it("restores the revision and returns the page without the body", async () => {
      const result = toolJson<PageSummary>(
        await callTool(token, "restore_page_revision", { page_id: page.id, revision_version: 1, version: 2 }),
      );
      expect(result).not.toHaveProperty("body");
      expect(result).toMatchObject({ id: page.id, title: "Title 1", version: 3, updated_by: member.id });
      expect(await readPage(page.id)).toMatchObject({ title: "Title 1", body: "Body 1", version: 3 });
      expect(await countRevisions(page.id)).toBe(2);
    });

    it("reports a stale version with guidance and changes nothing", async () => {
      const before = await readPage(page.id);
      expectToolError(
        await callTool(token, "restore_page_revision", { page_id: page.id, revision_version: 1, version: 1 }),
        "ページが他の人に更新されています。最新の内容を取得してからやり直してください。get_page で最新の version を取得してから restore_page_revision を呼んでください",
      );
      expect(await readPage(page.id)).toEqual(before);
      expect(await countRevisions(page.id)).toBe(1);
    });

    it.each([0, 1.5])("rejects version %s before checking the page", async (version) => {
      for (const page_id of [page.id, "missing"]) {
        expectToolError(
          await callTool(token, "restore_page_revision", { page_id, revision_version: 1, version }),
          invalidVersion,
        );
      }
      expect((await readPage(page.id))?.version).toBe(2);
    });

    it.each([2, 0, 1.5])("reports revision_version %s as missing", async (revision_version) => {
      expectToolError(
        await callTool(token, "restore_page_revision", { page_id: page.id, revision_version, version: 2 }),
        revisionNotFound,
      );
      expect((await readPage(page.id))?.version).toBe(2);
    });

    it("reports pages in inaccessible spaces and unknown pages as missing", async () => {
      for (const target of await inaccessiblePages()) {
        const before = await readPage(target.id);
        expectToolError(
          await callTool(token, "restore_page_revision", { page_id: target.id, revision_version: 1, version: 2 }),
          pageNotFound,
        );
        expect(await readPage(target.id)).toEqual(before);
      }
      expectToolError(
        await callTool(token, "restore_page_revision", { page_id: "missing", revision_version: 1, version: 1 }),
        pageNotFound,
      );
    });
  });
});

describe("MCP folder tools", () => {
  const spaceNotFound = "スペースが見つかりません";
  const folderNotFound = "フォルダが見つかりません";
  const invalidName = "フォルダの名前は 1 文字以上 100 文字以下で、改行などの制御文字を含まない文字列にしてください";

  let token: string;
  let everyone: SpaceRow;
  let other: SpaceRow;
  let adminSpace: SpaceRow;

  beforeEach(async () => {
    token = (await authorizeClient(memberCookies)).access_token;
    everyone = await insertSpace("everyone", "Everyone");
    other = await insertSpace("everyone", "Other");
    adminSpace = await insertSpace("admin", "Admins");
  });

  function readFolder(id: string): Promise<FolderRow | undefined> {
    return db.query.folders.findFirst({ where: eq(folders.id, id) });
  }

  function readPage(id: string): Promise<PageRow | undefined> {
    return db.query.pages.findFirst({ where: eq(pages.id, id) });
  }

  // Folders the member cannot use as a parent or a page folder in the everyone space.
  async function unusableFolders(): Promise<string[]> {
    const elsewhere = await insertFolder({ spaceId: other.id });
    const inAdminSpace = await insertFolder({ spaceId: adminSpace.id });
    const inOthersPersonal = await insertFolder({ spaceId: (await personalSpaceOf(admin)).id });
    return [elsewhere.id, inAdminSpace.id, inOthersPersonal.id, "missing"];
  }

  describe("list_folders", () => {
    it("returns the same folders as the REST API", async () => {
      const parent = await insertFolder({ spaceId: everyone.id, name: "b" });
      await insertFolder({ spaceId: everyone.id, parentId: parent.id, name: "a" });
      await insertFolder({ spaceId: other.id, name: "Elsewhere" });
      const rest = (await (await send(`/api/v1/spaces/${everyone.id}/folders`, { cookies: memberCookies })).json()) as FolderList;
      const result = toolJson<FolderList>(await callTool(token, "list_folders", { space_id: everyone.id }));
      expect(result).toEqual(rest);
      expect(result.folders.map((f) => f.name)).toEqual(["a", "b"]);
    });

    it("reports inaccessible and unknown spaces as missing", async () => {
      for (const spaceId of [adminSpace.id, (await personalSpaceOf(admin)).id, "missing"]) {
        expectToolError(await callTool(token, "list_folders", { space_id: spaceId }), spaceNotFound);
      }
    });
  });

  describe("create_folder", () => {
    it("creates a folder at the top level and inside another folder", async () => {
      const top = toolJson<Folder>(await callTool(token, "create_folder", { space_id: everyone.id, name: "  Docs  " }));
      expect(top).toMatchObject({
        space_id: everyone.id,
        parent_id: null,
        name: "Docs",
        created_by: member.id,
        updated_by: member.id,
      });
      const child = toolJson<Folder>(
        await callTool(token, "create_folder", { space_id: everyone.id, name: "Child", parent_id: top.id }),
      );
      expect(child.parent_id).toBe(top.id);
      expect(await readFolder(child.id)).toMatchObject({ spaceId: everyone.id, parentId: top.id, name: "Child" });
    });

    it("rejects an invalid name", async () => {
      expectToolError(await callTool(token, "create_folder", { space_id: everyone.id, name: "a\nb" }), invalidName);
      expect(await countFolders()).toBe(0);
    });

    it("rejects an empty parent_id", async () => {
      expectToolError(
        await callTool(token, "create_folder", { space_id: everyone.id, name: "Docs", parent_id: "" }),
        "parent_id はフォルダの id か null で指定してください",
      );
      expect(await countFolders()).toBe(0);
    });

    it("rejects a parent in another space or an inaccessible space", async () => {
      const ids = await unusableFolders();
      for (const parentId of ids) {
        expectToolError(
          await callTool(token, "create_folder", { space_id: everyone.id, name: "Docs", parent_id: parentId }),
          "親フォルダが見つかりません",
        );
      }
      expect(await countFolders()).toBe(3);
    });

    it("reports inaccessible and unknown spaces as missing", async () => {
      for (const spaceId of [adminSpace.id, (await personalSpaceOf(admin)).id, "missing"]) {
        expectToolError(await callTool(token, "create_folder", { space_id: spaceId, name: "Docs" }), spaceNotFound);
      }
      expect(await countFolders()).toBe(0);
    });
  });

  describe("update_folder", () => {
    let folder: FolderRow;

    beforeEach(async () => {
      folder = await insertFolder({ spaceId: everyone.id, name: "Docs", createdBy: admin.id });
    });

    it("renames the folder", async () => {
      const result = toolJson<Folder>(await callTool(token, "update_folder", { folder_id: folder.id, name: "Guides" }));
      expect(result).toMatchObject({ id: folder.id, name: "Guides", parent_id: null, updated_by: member.id });
    });

    it("moves the folder into another folder and back to the top level with null", async () => {
      const target = await insertFolder({ spaceId: everyone.id, name: "Target" });
      const moved = toolJson<Folder>(await callTool(token, "update_folder", { folder_id: folder.id, parent_id: target.id }));
      expect(moved.parent_id).toBe(target.id);
      const top = toolJson<Folder>(await callTool(token, "update_folder", { folder_id: folder.id, parent_id: null }));
      expect(top.parent_id).toBeNull();
      expect(await readFolder(folder.id)).toMatchObject({ parentId: null, name: "Docs" });
    });

    it("rejects moving the folder into itself or a descendant", async () => {
      const child = await insertFolder({ spaceId: everyone.id, parentId: folder.id });
      const grandchild = await insertFolder({ spaceId: everyone.id, parentId: child.id });
      for (const parentId of [folder.id, grandchild.id]) {
        expectToolError(
          await callTool(token, "update_folder", { folder_id: folder.id, parent_id: parentId }),
          "フォルダを自分自身やその中のフォルダへは移せません",
        );
      }
      expect(await readFolder(folder.id)).toEqual(folder);
    });

    it("rejects a parent in another space or an inaccessible space", async () => {
      for (const parentId of await unusableFolders()) {
        expectToolError(
          await callTool(token, "update_folder", { folder_id: folder.id, parent_id: parentId }),
          "移動先のフォルダが見つかりません",
        );
      }
      expect(await readFolder(folder.id)).toEqual(folder);
    });

    it("requires a name or a parent_id", async () => {
      expectToolError(
        await callTool(token, "update_folder", { folder_id: folder.id }),
        "name か parent_id のどちらかを指定してください",
      );
    });

    it("reports folders in inaccessible spaces as missing", async () => {
      const inAdminSpace = await insertFolder({ spaceId: adminSpace.id });
      expectToolError(await callTool(token, "update_folder", { folder_id: inAdminSpace.id, name: "X" }), folderNotFound);
      expect(await readFolder(inAdminSpace.id)).toEqual(inAdminSpace);
    });
  });

  describe("delete_folder", () => {
    it("deletes an empty folder", async () => {
      const folder = await insertFolder({ spaceId: everyone.id });
      const result = toolJson<{ id: string; deleted: boolean }>(
        await callTool(token, "delete_folder", { folder_id: folder.id }),
      );
      expect(result).toEqual({ id: folder.id, deleted: true });
      expect(await readFolder(folder.id)).toBeUndefined();
      expectToolError(await callTool(token, "delete_folder", { folder_id: folder.id }), folderNotFound);
    });

    it("refuses to delete a folder with a subfolder or a page", async () => {
      const withFolder = await insertFolder({ spaceId: everyone.id });
      await insertFolder({ spaceId: everyone.id, parentId: withFolder.id });
      const withPage = await insertFolder({ spaceId: everyone.id });
      await insertPage({ spaceId: everyone.id, folderId: withPage.id });
      for (const folder of [withFolder, withPage]) {
        expectToolError(
          await callTool(token, "delete_folder", { folder_id: folder.id }),
          "中にページかフォルダがあるフォルダは削除できません。中身を移すか削除してから消してください",
        );
        expect(await readFolder(folder.id)).toEqual(folder);
      }
    });
  });

  describe("delete_folder with pages in the trash", () => {
    it("deletes a folder with only pages in the trash and moves them to the top level", async () => {
      const folder = await insertFolder({ spaceId: everyone.id });
      const trashed = await insertPage({ spaceId: everyone.id, folderId: folder.id, deletedAt: Date.now() });
      const result = toolJson<{ id: string; deleted: boolean }>(
        await callTool(token, "delete_folder", { folder_id: folder.id }),
      );
      expect(result).toEqual({ id: folder.id, deleted: true });
      expect(await readFolder(folder.id)).toBeUndefined();
      expect(await readPage(trashed.id)).toEqual({ ...trashed, folderId: null });
    });
  });

  describe("pages in folders", () => {
    it("creates a page in a folder with create_page", async () => {
      const folder = await insertFolder({ spaceId: everyone.id });
      const result = toolJson<PageSummary>(
        await callTool(token, "create_page", { space_id: everyone.id, title: "T", body: "", folder_id: folder.id }),
      );
      expect(result.folder_id).toBe(folder.id);
      expect(await readPage(result.id)).toMatchObject({ folderId: folder.id });
    });

    it("rejects a folder in another space or an inaccessible space with create_page", async () => {
      for (const folderId of await unusableFolders()) {
        expectToolError(
          await callTool(token, "create_page", { space_id: everyone.id, title: "T", body: "", folder_id: folderId }),
          folderNotFound,
        );
      }
      expect(await countPages()).toBe(0);
    });

    it("moves a page with update_page and back to the top level with null", async () => {
      const folder = await insertFolder({ spaceId: everyone.id });
      const page = await insertPage({ spaceId: everyone.id });
      const moved = toolJson<PageSummary>(
        await callTool(token, "update_page", { page_id: page.id, version: 1, folder_id: folder.id }),
      );
      expect(moved).toMatchObject({ folder_id: folder.id, version: 2 });
      const top = toolJson<PageSummary>(
        await callTool(token, "update_page", { page_id: page.id, version: 2, folder_id: null }),
      );
      expect(top).toMatchObject({ folder_id: null, version: 3 });
    });

    it("rejects a folder in another space or an inaccessible space with update_page", async () => {
      const page = await insertPage({ spaceId: everyone.id });
      for (const folderId of await unusableFolders()) {
        expectToolError(
          await callTool(token, "update_page", { page_id: page.id, version: 1, folder_id: folderId }),
          folderNotFound,
        );
      }
      expectToolError(
        await callTool(token, "update_page", { page_id: page.id, version: 1, folder_id: "" }),
        "folder_id はフォルダの id か null で指定してください",
      );
      expect(await readPage(page.id)).toEqual(page);
    });
  });
});

describe("MCP trash tools", () => {
  const pageNotFound = "ページが見つかりません";
  const spaceNotFound = "スペースが見つかりません";
  const notInTrash = "このページはゴミ箱にありません";

  let token: string;
  let everyone: SpaceRow;

  beforeEach(async () => {
    token = (await authorizeClient(memberCookies)).access_token;
    everyone = await insertSpace("everyone", "Everyone");
  });

  function readPage(id: string): Promise<PageRow | undefined> {
    return db.query.pages.findFirst({ where: eq(pages.id, id) });
  }

  describe("delete_page", () => {
    it("moves the page to the trash and hides it from get_page, list_pages and search_pages", async () => {
      const page = await insertPage({ spaceId: everyone.id, title: "Deploy", body: "deploy steps" });
      const result = toolJson<{ id: string; trashed: boolean }>(
        await callTool(token, "delete_page", { page_id: page.id }),
      );
      expect(result).toEqual({ id: page.id, trashed: true });
      expect(await readPage(page.id)).toMatchObject({ deletedBy: member.id, version: 1 });

      expectToolError(await callTool(token, "get_page", { page_id: page.id }), pageNotFound);
      expect(toolJson<PageList>(await callTool(token, "list_pages", { space_id: everyone.id })).pages).toEqual([]);
      expect(toolJson<SearchResult>(await callTool(token, "search_pages", { query: "deploy" })).hits).toEqual([]);
      expectToolError(await callTool(token, "delete_page", { page_id: page.id }), pageNotFound);
    });

    it("does not move a page in a space the user cannot access", async () => {
      const adminPage = await insertPage({ spaceId: (await insertSpace("admin", "Admins")).id });
      const othersPage = await insertPage({ spaceId: (await personalSpaceOf(admin)).id });
      for (const page of [adminPage, othersPage]) {
        expectToolError(await callTool(token, "delete_page", { page_id: page.id }), pageNotFound);
        expect(await readPage(page.id)).toEqual(page);
      }
    });
  });

  describe("list_trash", () => {
    it("returns the same list as the REST API", async () => {
      const page = await insertPage({ spaceId: everyone.id });
      toolJson(await callTool(token, "delete_page", { page_id: page.id }));
      const rest = (await (await send(`/api/v1/spaces/${everyone.id}/trash`, { cookies: memberCookies })).json()) as TrashList;
      const result = toolJson<TrashList>(await callTool(token, "list_trash", { space_id: everyone.id }));
      expect(result).toEqual(rest);
      expect(result.pages.map((p) => p.id)).toEqual([page.id]);
    });

    it("does not list the trash of a space the user cannot access", async () => {
      const adminSpace = await insertSpace("admin", "Admins");
      for (const spaceId of [adminSpace.id, (await personalSpaceOf(admin)).id, "missing"]) {
        expectToolError(await callTool(token, "list_trash", { space_id: spaceId }), spaceNotFound);
      }
    });
  });

  describe("restore_page", () => {
    it("takes the page out of the trash and returns it without the body", async () => {
      const page = await insertPage({ spaceId: everyone.id, body: "# Body" });
      toolJson(await callTool(token, "delete_page", { page_id: page.id }));
      const result = toolJson<PageSummary>(await callTool(token, "restore_page", { page_id: page.id }));
      expect(result).toMatchObject({ id: page.id, version: 1 });
      expect(result).not.toHaveProperty("body");
      expect(await readPage(page.id)).toEqual(page);
    });

    it("reports a page that is not in the trash, and a missing or inaccessible one", async () => {
      const page = await insertPage({ spaceId: everyone.id });
      expectToolError(await callTool(token, "restore_page", { page_id: page.id }), notInTrash);
      const adminPage = await insertPage({ spaceId: (await insertSpace("admin", "Admins")).id, deletedAt: Date.now() });
      for (const pageId of [adminPage.id, "missing"]) {
        expectToolError(await callTool(token, "restore_page", { page_id: pageId }), pageNotFound);
      }
      expect(await readPage(adminPage.id)).toEqual(adminPage);
    });
  });
});

describe("MCP attachment tools", () => {
  const pageNotFound = "ページが見つかりません";
  const tooLarge = "MCP から添付できるファイルは 2MB までです。大きなファイルは Web の編集画面から添付してください";
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  const MAX = 2 * 1024 * 1024;

  let token: string;
  let everyone: SpaceRow;

  beforeEach(async () => {
    await resetAttachments();
    token = (await authorizeClient(memberCookies)).access_token;
    everyone = await insertSpace("everyone", "Everyone");
  });

  function toBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  function pngOfSize(size: number): Uint8Array {
    const bytes = new Uint8Array(size);
    bytes.set(PNG);
    return bytes;
  }

  describe("upload_attachment", () => {
    it("attaches a file and returns it with the Markdown to put in the body", async () => {
      const page = await insertPage({ spaceId: everyone.id });
      const base64 = toBase64(PNG).replace(/(.{4})/g, "$1\n");
      const result = toolJson<Attachment>(
        await callTool(token, "upload_attachment", { page_id: page.id, filename: "diagram", content_base64: base64 }),
      );
      expect(result).toMatchObject({
        page_id: page.id,
        filename: "diagram.png",
        content_type: "image/png",
        size: PNG.byteLength,
        created_by: member.id,
        url: `/api/v1/attachments/${result.id}`,
        markdown: `![diagram.png](/api/v1/attachments/${result.id})`,
      });
      const object = await env.ATTACHMENTS.get(`attachments/${result.id}`);
      expect(new Uint8Array((await object?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(PNG);
    });

    it("accepts exactly 2MB and rejects one byte more", async () => {
      const page = await insertPage({ spaceId: everyone.id });
      const exact = await callTool(token, "upload_attachment", {
        page_id: page.id,
        filename: "big.png",
        content_base64: toBase64(pngOfSize(MAX)),
      });
      expect(toolJson<Attachment>(exact).size).toBe(MAX);
      expectToolError(
        await callTool(token, "upload_attachment", {
          page_id: page.id,
          filename: "big.png",
          content_base64: toBase64(pngOfSize(MAX + 1)),
        }),
        tooLarge,
      );
    });

    it("rejects base64 longer than 2MB allows before decoding it", async () => {
      const page = await insertPage({ spaceId: everyone.id });
      const length = 4 * Math.ceil(MAX / 3) + 65536 + 1;
      expectToolError(
        await callTool(token, "upload_attachment", {
          page_id: page.id,
          filename: "big.png",
          content_base64: "!".repeat(length),
        }),
        tooLarge,
      );
    });

    it.each([
      ["base64 that cannot be read", { filename: "a.png", content_base64: "not base64!" }, "content_base64 が base64 として読めません"],
      ["an empty file", { filename: "a.png", content_base64: "" }, "空のファイルは添付できません"],
      [
        "SVG",
        { filename: "a.svg", content_base64: btoa("<svg xmlns='http://www.w3.org/2000/svg'/>") },
        "添付できるのは PNG・JPEG・GIF・WebP の画像と PDF です",
      ],
      ["an empty filename", { filename: " ", content_base64: "" }, "ファイル名は 1 文字以上 250 文字以下にしてください"],
    ])("rejects %s", async (_, args, message) => {
      const page = await insertPage({ spaceId: everyone.id });
      expectToolError(await callTool(token, "upload_attachment", { page_id: page.id, ...args }), message);
    });

    it("reports the pages it cannot access as missing", async () => {
      const adminSpace = await insertSpace("admin", "Admins");
      const adminPage = await insertPage({ spaceId: adminSpace.id });
      const trashed = await insertPage({ spaceId: everyone.id, deletedAt: Date.now() });
      for (const pageId of [adminPage.id, trashed.id, "missing"]) {
        expectToolError(
          await callTool(token, "upload_attachment", { page_id: pageId, filename: "a.png", content_base64: toBase64(PNG) }),
          pageNotFound,
        );
      }
      const listed = await env.ATTACHMENTS.list();
      expect(listed.objects).toEqual([]);
    });
  });

  describe("list_attachments", () => {
    it("lists the attachments of the page, oldest first", async () => {
      const page = await insertPage({ spaceId: everyone.id });
      const first = toolJson<Attachment>(
        await callTool(token, "upload_attachment", { page_id: page.id, filename: "a", content_base64: toBase64(PNG) }),
      );
      const result = toolJson<AttachmentList>(await callTool(token, "list_attachments", { page_id: page.id }));
      expect(result).toEqual({ attachments: [first] });
    });

    it("reports the pages it cannot access as missing", async () => {
      const adminSpace = await insertSpace("admin", "Admins");
      const adminPage = await insertPage({ spaceId: adminSpace.id });
      const trashed = await insertPage({ spaceId: everyone.id, deletedAt: Date.now() });
      for (const pageId of [adminPage.id, trashed.id, "missing"]) {
        expectToolError(await callTool(token, "list_attachments", { page_id: pageId }), pageNotFound);
      }
    });
  });
});

describe("MCP move tools", () => {
  const spaceNotFound = "移動先のスペースが見つかりません";

  let token: string;
  let everyone: SpaceRow;
  let other: SpaceRow;
  let adminSpace: SpaceRow;
  let personal: SpaceRow;

  beforeEach(async () => {
    token = (await authorizeClient(memberCookies)).access_token;
    everyone = await insertSpace("everyone", "Everyone");
    other = await insertSpace("everyone", "Other");
    adminSpace = await insertSpace("admin", "Admins");
    personal = await personalSpaceOf(member);
  });

  function readPage(id: string): Promise<PageRow | undefined> {
    return db.query.pages.findFirst({ where: eq(pages.id, id) });
  }

  function readFolder(id: string): Promise<FolderRow | undefined> {
    return db.query.folders.findFirst({ where: eq(folders.id, id) });
  }

  function widerMessage(destName: string, to: string, from: string): string {
    return (
      `移動先のスペース「${destName}」（${to}）は、移動元（${from}）より多くの人が見られます。` +
      "ページの過去の版（履歴）と添付ファイルも見られるようになります。" +
      "利用者に確認してから acknowledge_wider_visibility: true を付けて呼んでください"
    );
  }

  describe("move_page", () => {
    it("moves a page to a folder of another space and returns it without the body", async () => {
      const page = await insertPage({ spaceId: everyone.id, body: "# Body" });
      const folder = await insertFolder({ spaceId: other.id });
      const result = toolJson<PageSummary>(
        await callTool(token, "move_page", { page_id: page.id, version: 1, space_id: other.id, folder_id: folder.id }),
      );
      expect(result).toMatchObject({ id: page.id, space_id: other.id, folder_id: folder.id, version: 2 });
      expect(result).not.toHaveProperty("body");
      expect(await readPage(page.id)).toMatchObject({ spaceId: other.id, folderId: folder.id, version: 2 });
    });

    it("needs the acknowledgement to move a page to a space more people can see", async () => {
      const page = await insertPage({ spaceId: personal.id });
      const message = widerMessage("Everyone", "全員", "個人（本人のみ）");
      expectToolError(await callTool(token, "move_page", { page_id: page.id, version: 1, space_id: everyone.id }), message);
      expectToolError(
        await callTool(token, "move_page", {
          page_id: page.id,
          version: 1,
          space_id: everyone.id,
          acknowledge_wider_visibility: false,
        }),
        message,
      );
      expect(await readPage(page.id)).toEqual(page);

      const moved = toolJson<PageSummary>(
        await callTool(token, "move_page", {
          page_id: page.id,
          version: 1,
          space_id: everyone.id,
          acknowledge_wider_visibility: true,
        }),
      );
      expect(moved).toMatchObject({ space_id: everyone.id, version: 2 });
    });

    it("names the kinds of an admin space in the message", async () => {
      const adminToken = (await authorizeClient(adminCookies)).access_token;
      const page = await insertPage({ spaceId: (await personalSpaceOf(admin)).id });
      expectToolError(
        await callTool(adminToken, "move_page", { page_id: page.id, version: 1, space_id: adminSpace.id }),
        widerMessage("Admins", "管理者のみ", "個人（本人のみ）"),
      );
      const adminPage = await insertPage({ spaceId: adminSpace.id });
      expectToolError(
        await callTool(adminToken, "move_page", { page_id: adminPage.id, version: 1, space_id: everyone.id }),
        widerMessage("Everyone", "全員", "管理者のみ"),
      );
    });

    it("needs no acknowledgement for a move that does not widen the visibility", async () => {
      const page = await insertPage({ spaceId: everyone.id });
      expect(
        toolJson<PageSummary>(await callTool(token, "move_page", { page_id: page.id, version: 1, space_id: other.id })),
      ).toMatchObject({ space_id: other.id });
      // Narrowing: only the user can see it now.
      expect(
        toolJson<PageSummary>(
          await callTool(token, "move_page", { page_id: page.id, version: 2, space_id: personal.id, folder_id: null }),
        ),
      ).toMatchObject({ space_id: personal.id, version: 3 });
    });

    it("reports a destination the user cannot access before the visibility", async () => {
      const page = await insertPage({ spaceId: personal.id });
      for (const spaceId of [adminSpace.id, (await personalSpaceOf(admin)).id, "missing"]) {
        expectToolError(
          await callTool(token, "move_page", { page_id: page.id, version: 1, space_id: spaceId }),
          spaceNotFound,
        );
      }
      expect(await readPage(page.id)).toEqual(page);
    });

    it("reports a missing page, a folder outside the destination and a conflict", async () => {
      const page = await insertPage({ spaceId: everyone.id });
      const inSource = await insertFolder({ spaceId: everyone.id });
      expectToolError(
        await callTool(token, "move_page", { page_id: "missing", version: 1, space_id: other.id }),
        "ページが見つかりません",
      );
      expectToolError(
        await callTool(token, "move_page", { page_id: page.id, version: 1, space_id: other.id, folder_id: inSource.id }),
        "移動先のフォルダが見つかりません",
      );
      const conflict = await callTool(token, "move_page", { page_id: page.id, version: 2, space_id: other.id });
      expect(conflict.isError).toBe(true);
      expect(conflict.content[0]?.text).toContain("get_page で最新の version を取得してから move_page を呼んでください");
      expectToolError(
        await callTool(token, "move_page", { page_id: page.id, version: 1, space_id: "" }),
        "space_id は移動先のスペースの id で指定してください",
      );
      expect(await readPage(page.id)).toEqual(page);
    });
  });

  describe("members spaces", () => {
    let adminToken: string;
    let team: SpaceRow;
    let otherTeam: SpaceRow;

    beforeEach(async () => {
      adminToken = (await authorizeClient(adminCookies)).access_token;
      team = await insertSpace("members", "Team");
      otherTeam = await insertSpace("members", "Other team");
    });

    function betweenMembersMessage(destName: string): string {
      return (
        `移動先のスペース「${destName}」（メンバー指定）は、移動元のメンバー指定スペースとは見られる人が違います。` +
        "ページの過去の版（履歴）と添付ファイルも見られるようになります。" +
        "利用者に確認してから acknowledge_wider_visibility: true を付けて呼んでください"
      );
    }

    it("needs the acknowledgement to move a page from an admin space to a members space", async () => {
      const page = await insertPage({ spaceId: adminSpace.id });
      expectToolError(
        await callTool(adminToken, "move_page", { page_id: page.id, version: 1, space_id: team.id }),
        widerMessage("Team", "メンバー指定（選ばれたユーザーと管理者）", "管理者のみ"),
      );
      expect(await readPage(page.id)).toEqual(page);
      expect(
        toolJson<PageSummary>(
          await callTool(adminToken, "move_page", {
            page_id: page.id,
            version: 1,
            space_id: team.id,
            acknowledge_wider_visibility: true,
          }),
        ),
      ).toMatchObject({ space_id: team.id, version: 2 });
    });

    it("needs the acknowledgement to move a page or a folder to another members space", async () => {
      const page = await insertPage({ spaceId: team.id });
      expectToolError(
        await callTool(adminToken, "move_page", { page_id: page.id, version: 1, space_id: otherTeam.id }),
        betweenMembersMessage("Other team"),
      );
      expect(await readPage(page.id)).toEqual(page);

      const folder = await insertFolder({ spaceId: team.id });
      expectToolError(
        await callTool(adminToken, "move_folder", { folder_id: folder.id, space_id: otherTeam.id }),
        betweenMembersMessage("Other team"),
      );
      expect(await readFolder(folder.id)).toEqual(folder);

      // Inside the same members space nothing widens.
      const inside = await insertFolder({ spaceId: team.id });
      expect(
        toolJson<Folder>(
          await callTool(adminToken, "move_folder", { folder_id: folder.id, space_id: team.id, parent_id: inside.id }),
        ),
      ).toMatchObject({ space_id: team.id, parent_id: inside.id });
    });

    it("needs the acknowledgement to move a folder from an admin space to a members space", async () => {
      const folder = await insertFolder({ spaceId: adminSpace.id });
      expectToolError(
        await callTool(adminToken, "move_folder", { folder_id: folder.id, space_id: team.id }),
        widerMessage("Team", "メンバー指定（選ばれたユーザーと管理者）", "管理者のみ"),
      );
      expect(await readFolder(folder.id)).toEqual(folder);
    });

    it("needs no acknowledgement to move from a members space to an admin space", async () => {
      const page = await insertPage({ spaceId: team.id });
      expect(
        toolJson<PageSummary>(
          await callTool(adminToken, "move_page", { page_id: page.id, version: 1, space_id: adminSpace.id }),
        ),
      ).toMatchObject({ space_id: adminSpace.id, version: 2 });
      const folder = await insertFolder({ spaceId: team.id });
      expect(
        toolJson<Folder>(await callTool(adminToken, "move_folder", { folder_id: folder.id, space_id: adminSpace.id })),
      ).toMatchObject({ space_id: adminSpace.id });
    });
  });

  describe("move_folder", () => {
    it("moves a folder with its contents to another space", async () => {
      const folder = await insertFolder({ spaceId: everyone.id });
      const child = await insertFolder({ spaceId: everyone.id, parentId: folder.id });
      const page = await insertPage({ spaceId: everyone.id, folderId: child.id });
      const result = toolJson<Folder>(await callTool(token, "move_folder", { folder_id: folder.id, space_id: other.id }));
      expect(result).toMatchObject({ id: folder.id, space_id: other.id, parent_id: null });
      expect(await readFolder(child.id)).toMatchObject({ spaceId: other.id, parentId: folder.id });
      expect(await readPage(page.id)).toMatchObject({ spaceId: other.id, folderId: child.id, version: 1 });
    });

    it("needs the acknowledgement to move a folder to a space more people can see", async () => {
      const folder = await insertFolder({ spaceId: personal.id });
      const target = await insertFolder({ spaceId: everyone.id });
      const page = await insertPage({ spaceId: personal.id, folderId: folder.id });
      const trashed = await insertPage({
        spaceId: personal.id,
        folderId: folder.id,
        deletedAt: Date.now(),
        deletedBy: member.id,
      });
      const message = widerMessage("Everyone", "全員", "個人（本人のみ）");
      for (const ack of [undefined, false]) {
        expectToolError(
          await callTool(token, "move_folder", {
            folder_id: folder.id,
            space_id: everyone.id,
            parent_id: target.id,
            ...(ack !== undefined && { acknowledge_wider_visibility: ack }),
          }),
          message,
        );
      }
      expect(await readFolder(folder.id)).toEqual(folder);
      expect(await readPage(page.id)).toEqual(page);
      expect(await readPage(trashed.id)).toEqual(trashed);

      const moved = toolJson<Folder>(
        await callTool(token, "move_folder", {
          folder_id: folder.id,
          space_id: everyone.id,
          parent_id: target.id,
          acknowledge_wider_visibility: true,
        }),
      );
      expect(moved).toMatchObject({ space_id: everyone.id, parent_id: target.id });
      expect(await readPage(page.id)).toMatchObject({ spaceId: everyone.id });
      expect(await readPage(trashed.id)).toMatchObject({ spaceId: everyone.id, deletedBy: member.id });
    });

    it("reports a destination the user cannot access before the visibility", async () => {
      const folder = await insertFolder({ spaceId: personal.id });
      for (const spaceId of [adminSpace.id, (await personalSpaceOf(admin)).id, "missing"]) {
        expectToolError(await callTool(token, "move_folder", { folder_id: folder.id, space_id: spaceId }), spaceNotFound);
      }
      expect(await readFolder(folder.id)).toEqual(folder);
    });

    it("reports a missing folder, a parent outside the destination and a cycle", async () => {
      const folder = await insertFolder({ spaceId: everyone.id });
      const child = await insertFolder({ spaceId: everyone.id, parentId: folder.id });
      expectToolError(
        await callTool(token, "move_folder", { folder_id: "missing", space_id: other.id }),
        "フォルダが見つかりません",
      );
      expectToolError(
        await callTool(token, "move_folder", { folder_id: folder.id, space_id: other.id, parent_id: child.id }),
        "移動先のフォルダが見つかりません",
      );
      expectToolError(
        await callTool(token, "move_folder", { folder_id: folder.id, space_id: everyone.id, parent_id: child.id }),
        "フォルダを自分自身やその中のフォルダへは移せません",
      );
      expect(await readFolder(folder.id)).toEqual(folder);
    });
  });
});

describe("origins and configuration", () => {
  it("returns 401 for a token issued in another AUTH_MODE", async () => {
    // Password mode on the host that later becomes APP_ORIGIN.
    const { access_token } = await authorizeClient(memberCookies, { origin: OIDC_ORIGIN });
    expect((await mcpRequest(access_token, "tools/list", {}, { origin: OIDC_ORIGIN })).status).toBe(200);
    const res = await mcpRequest(access_token, "tools/list", {}, { origin: OIDC_ORIGIN, env: oidcEnv });
    expect(res.status).toBe(401);
  });

  it("returns 404 for OAuth paths on hosts other than APP_ORIGIN in oidc mode", async () => {
    for (const path of ["/mcp", "/authorize", "/oauth/token", "/.well-known/oauth-authorization-server"]) {
      const res = await send(`https://other.example.com${path}`, { env: oidcEnv });
      expect(res.status).toBe(404);
    }
    const metadata = await send(`${OIDC_ORIGIN}/.well-known/oauth-authorization-server`, { env: oidcEnv });
    expect(metadata.status).toBe(200);
    // Pages still go through unifyHost.
    const page = await send("https://other.example.com/auth/setup", { env: oidcEnv });
    expect(page.status).toBe(302);
    expect(page.headers.get("Location")).toBe(`${OIDC_ORIGIN}/auth/setup`);
  });

  it("serves pages but not OAuth on a plain http host that is not loopback", async () => {
    const me = await send("http://wiki.example.com/api/v1/me", { cookies: memberCookies });
    expect(me.status).toBe(200);
    expect(await me.text()).toContain(member.email);
    expect((await send("http://wiki.example.com/mcp", { json: {} })).status).toBe(404);
    expect((await send("http://wiki.example.com/authorize")).status).toBe(404);
  });

  it("serves OAuth on loopback http", async () => {
    const res = await send("http://localhost:8787/.well-known/oauth-protected-resource/mcp");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { resource: string }).resource).toBe("http://localhost:8787/mcp");
  });

  it("returns 500 for every path when the configuration is invalid", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const path of ["/mcp", "/.well-known/oauth-authorization-server", "/oauth/token", "/authorize"]) {
      const res = await send(path, { env: { JWT_SECRET: "short" } });
      expect(res.status).toBe(500);
    }
    expect(errorLog).toHaveBeenCalledWith("invalid configuration", { invalid: ["JWT_SECRET"] });
  });

  it("uses the helpers of the request's origin when the env object is reused", async () => {
    const shared: Cloudflare.Env = { ...env };
    const other = "https://second.libreno.test";
    const first = await authorizeClient(memberCookies, { sharedEnv: shared });
    const second = await authorizeClient(memberCookies, { origin: other, sharedEnv: shared });
    expect(first.resource).toBe(`${ORIGIN}/mcp`);
    expect(second.resource).toBe(`${other}/mcp`);
    expect(shared.OAUTH_PROVIDER).toBeUndefined();
    expect((await mcpRequest(second.access_token, "tools/list", {}, { origin: other, sharedEnv: shared })).status).toBe(
      200,
    );
    // Tokens are bound to their origin's resource.
    expect((await mcpRequest(first.access_token, "tools/list", {}, { origin: other, sharedEnv: shared })).status).toBe(
      401,
    );
  });
});

describe("archived spaces", () => {
  const archivedMessage = "アーカイブされたスペースは編集できません。アーカイブを解除してから操作してください";

  let token: string;
  let archived: SpaceRow;
  let active: SpaceRow;

  beforeEach(async () => {
    token = (await authorizeClient(memberCookies)).access_token;
    archived = await insertSpace("everyone", "Archived");
    active = await insertSpace("everyone", "Active");
    await db.update(spaces).set({ archivedAt: Date.now() }).where(eq(spaces.id, archived.id));
  });

  it("lists archived spaces only with archived=true, as the REST API does", async () => {
    const usual = toolJson<SpaceList>(await callTool(token, "list_spaces"));
    expect(usual.spaces.map((s) => s.id)).not.toContain(archived.id);
    expect(usual.spaces.map((s) => s.id)).toContain(active.id);
    expect(toolJson<SpaceList>(await callTool(token, "list_spaces", { archived: false }))).toEqual(usual);

    const onlyArchived = toolJson<SpaceList>(await callTool(token, "list_spaces", { archived: true }));
    expect(onlyArchived.spaces.map((s) => s.id)).toEqual([archived.id]);
    expect(onlyArchived.spaces[0]?.archived_at).not.toBeNull();
    const rest = (await (await send("/api/v1/spaces?archived=true", { cookies: memberCookies })).json()) as SpaceList;
    expect(onlyArchived).toEqual(rest);
  });

  it("rejects the write tools with the message of the REST API", async () => {
    const page = await insertPage({ spaceId: archived.id, title: "Page" });
    expectToolError(
      await callTool(token, "create_page", { space_id: archived.id, title: "T", body: "" }),
      archivedMessage,
    );
    expectToolError(
      await callTool(token, "update_page", { page_id: page.id, version: 1, title: "X" }),
      archivedMessage,
    );
    expectToolError(await callTool(token, "delete_page", { page_id: page.id }), archivedMessage);
    expectToolError(await callTool(token, "create_folder", { space_id: archived.id, name: "F" }), archivedMessage);
    expect((await db.query.pages.findFirst({ where: eq(pages.id, page.id) }))?.title).toBe("Page");
  });

  it("leaves archived spaces out of search_pages unless space_id is given", async () => {
    const hidden = await insertPage({ spaceId: archived.id, title: "needle" });
    const shown = await insertPage({ spaceId: active.id, title: "needle" });
    const all = toolJson<SearchResult>(await callTool(token, "search_pages", { query: "needle" }));
    expect(all.hits.map((hit) => hit.id)).toEqual([shown.id]);
    const one = toolJson<SearchResult>(await callTool(token, "search_pages", { query: "needle", space_id: archived.id }));
    expect(one.hits.map((hit) => hit.id)).toEqual([hidden.id]);
  });
});
