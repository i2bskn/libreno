import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { base64UrlEncode } from "@i2bskn/workers-app-core";
import { users } from "../src/db/schema";
import type { Bindings } from "../src/env";
import {
  countPersonalSpaces,
  countSpaces,
  createUserWithoutSpace,
  db,
  OIDC_ORIGIN,
  oidcEnv,
  resetDb,
  send,
  sessionCookies,
  setCookies,
} from "./helpers";

const ISSUER = oidcEnv.OIDC_ISSUER ?? "";
const CLIENT_ID = oidcEnv.OIDC_CLIENT_ID ?? "";

beforeEach(resetDb);

describe("OIDC flow with a mocked IdP", () => {
  const KID = "test-key";
  let keyPair: CryptoKeyPair;
  let signingKey: CryptoKey;
  let publicJwk: JsonWebKey;
  let idTokenClaims: Record<string, unknown>;
  let tokenRequests: { authorization: string | null; body: URLSearchParams }[];

  beforeAll(async () => {
    const generate = async () =>
      (await crypto.subtle.generateKey(
        { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true,
        ["sign", "verify"],
      )) as CryptoKeyPair;
    keyPair = await generate();
    publicJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
  });

  async function signIdToken(claims: Record<string, unknown>): Promise<string> {
    const encode = (value: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
    const input = `${encode({ alg: "RS256", kid: KID, typ: "JWT" })}.${encode(claims)}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, new TextEncoder().encode(input));
    return `${input}.${base64UrlEncode(new Uint8Array(signature))}`;
  }

  beforeEach(() => {
    tokenRequests = [];
    signingKey = keyPair.privateKey;
    idTokenClaims = { email: "alice@example.com", email_verified: true, name: "Alice" };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
      if (url.href === `${ISSUER}/.well-known/openid-configuration`) {
        return json({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        });
      }
      if (url.href === `${ISSUER}/jwks`) {
        return json({ keys: [{ ...publicJwk, kid: KID, alg: "RS256", use: "sig" }] });
      }
      if (url.href === `${ISSUER}/token`) {
        const body = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));
        tokenRequests.push({ authorization: request.headers.get("Authorization"), body });
        const now = Math.floor(Date.now() / 1000);
        const idToken = await signIdToken({
          iss: ISSUER,
          sub: "sub-1",
          aud: CLIENT_ID,
          iat: now,
          exp: now + 300,
          nonce: pendingNonce,
          ...idTokenClaims,
        });
        return json({ access_token: "access", token_type: "Bearer", expires_in: 300, id_token: idToken });
      }
      return new Response("not found", { status: 404 });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  let pendingNonce = "";

  async function startLogin(next = "/wiki", env: Partial<Bindings> = oidcEnv) {
    const res = await send(`${OIDC_ORIGIN}/auth/login?next=${encodeURIComponent(next)}`, { env });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "");
    pendingNonce = location.searchParams.get("nonce") ?? "";
    const oidcCookie = setCookies(res)["__Host-libreno_oidc"];
    expect(oidcCookie?.maxAge).toBe(600);
    return { location, oidcCookie: oidcCookie?.value ?? "" };
  }

  function callback(query: string, oidcCookie?: string, env: Partial<Bindings> = oidcEnv) {
    return send(`${OIDC_ORIGIN}/auth/oidc/callback?${query}`, {
      env,
      cookies: oidcCookie ? { "__Host-libreno_oidc": oidcCookie } : undefined,
    });
  }

  async function loginWith(env: Partial<Bindings> = oidcEnv) {
    const { location, oidcCookie } = await startLogin("/wiki", env);
    return callback(`code=abc&state=${location.searchParams.get("state")}`, oidcCookie, env);
  }

  it("creates the first user as admin and later users as members, each with a personal space (JIT)", async () => {
    expect((await loginWith()).status).toBe(303);
    idTokenClaims = { ...idTokenClaims, sub: "sub-2", email: "bob@example.com", name: "Bob" };
    expect((await loginWith()).status).toBe(303);

    const alice = await db.query.users.findFirst({ where: eq(users.oidcSubject, "sub-1") });
    const bob = await db.query.users.findFirst({ where: eq(users.oidcSubject, "sub-2") });
    expect(alice).toMatchObject({ role: "admin", email: "alice@example.com" });
    expect(bob).toMatchObject({ role: "member", email: "bob@example.com" });
    expect(await countPersonalSpaces(alice?.id ?? "")).toBe(1);
    expect(await countPersonalSpaces(bob?.id ?? "")).toBe(1);
    expect(await countSpaces()).toBe(2);
  });

  it("redirects to the IdP with PKCE and signs the user in on callback", async () => {
    const { location, oidcCookie } = await startLogin();
    expect(`${location.origin}${location.pathname}`).toBe(`${ISSUER}/authorize`);
    expect(location.searchParams.get("redirect_uri")).toBe(`${OIDC_ORIGIN}/auth/oidc/callback`);
    expect(location.searchParams.get("scope")).toBe("openid email profile");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("client_id")).toBe(CLIENT_ID);

    const state = location.searchParams.get("state") ?? "";
    const res = await callback(`code=abc&state=${state}`, oidcCookie);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/wiki");
    expect(setCookies(res)["__Host-libreno_oidc"]?.maxAge).toBe(0);
    const cookies = sessionCookies(res);
    expect(setCookies(res)["__Host-libreno_rt"]?.maxAge).toBe(24 * 60 * 60);

    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]?.authorization).toMatch(/^Basic /);
    expect(tokenRequests[0]?.body.get("code")).toBe("abc");
    expect(tokenRequests[0]?.body.get("redirect_uri")).toBe(`${OIDC_ORIGIN}/auth/oidc/callback`);
    expect(tokenRequests[0]?.body.get("code_verifier")).toBeTruthy();

    const me = await send(`${OIDC_ORIGIN}/api/v1/me`, { env: oidcEnv, cookies });
    expect(await me.json()).toMatchObject({ email: "alice@example.com", name: "Alice", role: "admin" });
    const user = await db.query.users.findFirst({ where: eq(users.oidcSubject, "sub-1") });
    expect(await countPersonalSpaces(user?.id ?? "")).toBe(1);
    expect(await countSpaces()).toBe(1);
  });

  it("creates a missing personal space when an existing user signs in, only once", async () => {
    const legacy = await createUserWithoutSpace({
      email: "alice@example.com",
      oidc: { issuer: ISSUER, subject: "sub-1" },
    });
    for (let i = 0; i < 2; i++) {
      const { location, oidcCookie } = await startLogin();
      const res = await callback(`code=abc&state=${location.searchParams.get("state")}`, oidcCookie);
      expect(res.status).toBe(303);
      expect(await countPersonalSpaces(legacy.id)).toBe(1);
    }
    expect(await db.query.users.findMany()).toHaveLength(1);
  });

  it("returns 403 and creates nothing when ALLOWED_EMAILS is empty", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await loginWith({ ...oidcEnv, ALLOWED_EMAILS: "" });
    expect(res.status).toBe(403);
    expect(await db.query.users.findMany()).toHaveLength(0);
    expect(await countSpaces()).toBe(0);
    expect(warn).toHaveBeenCalledWith("oidc login rejected", { reason: "allowlist_empty" });
  });

  it("signs in any email with ALLOWED_EMAILS=*", async () => {
    idTokenClaims = { ...idTokenClaims, email: "alice@outside.test" };
    const res = await loginWith({ ...oidcEnv, ALLOWED_EMAILS: "*" });
    expect(res.status).toBe(303);
    const user = await db.query.users.findFirst({ where: eq(users.oidcSubject, "sub-1") });
    expect(user?.email).toBe("alice@outside.test");
    expect(await countPersonalSpaces(user?.id ?? "")).toBe(1);
  });

  it("ends a signed-in session on its next refresh once ALLOWED_EMAILS is empty", async () => {
    const res = await loginWith();
    expect(res.status).toBe(303);
    const cookies = sessionCookies(res);

    const refreshed = await send(`${OIDC_ORIGIN}/auth/refresh`, {
      method: "POST",
      cookies,
      env: { ...oidcEnv, ALLOWED_EMAILS: "" },
    });
    expect(refreshed.status).toBe(401);
    // The session family is revoked: the refresh token no longer works with the allowlist restored.
    const again = await send(`${OIDC_ORIGIN}/auth/refresh`, { method: "POST", cookies, env: oidcEnv });
    expect(again.status).toBe(401);
  });
});
